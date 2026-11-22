// solve.js — a fast drop-in for csv-reader 1.0.0.
//
// Written from scratch from the competition's prose specification in
// RULES.txt ("Read broken CSV files faster, 21 November 2026").
// Dependency-free ES module. run({text, header}) returns
// {columns, rows, errors} with csv-reader's exact semantics:
//
//  * The text is read once, left to right, with commas and double quotes.
//    A U+FEFF at its very start is dropped.
//  * A record ends at LF or CRLF; a line left with no characters is no
//    record. Outside quotes a CR not followed by LF is dropped
//    (error stray_cr).
//  * A field that opens with a quote runs to the next quote that is not
//    doubled; "" inside it is one quote and each CRLF or lone CR inside
//    it reads as LF. What follows its closing quote, up to the next comma
//    or line break, is appended as it stands (quote_junk, when the field
//    ends). A quote that never closes is a literal character and the text
//    after it is read again as unquoted (unterminated_quote). A quote
//    inside an unquoted field is a literal character.
//  * Fields stay strings, never trimmed or converted.
//  * columns is the first record when header is true, else null; rows
//    holds the records after it (every record when header is false), each
//    padded with empty strings (short_row, with fields: its field count)
//    or cut (long_row, with extra: the cut fields) to the first record's
//    width.
//  * Each error is {code, line, row} in the order met; a record's
//    short_row or long_row when it ends. line is the 1-based line (each
//    LF, CRLF and lone CR inside quotes counts one), the record's start
//    line for short_row/long_row and the line where the error is met for
//    the others; row is the record's index in rows, null for the header.
//
// Speed notes: the hot path finds field ends with String.indexOf (native
// memchr-class scans) and slices field values out instead of building
// them character by character. Per-case state is created fresh inside
// run(); nothing is shared or cached between cases.

const CR = 13;
const LF = 10;
const COMMA = 44;
const QUOTE = 34;
const BOM = 0xfeff;

// Count '\n' code units in a string (used only on quoted-field content
// that is already known to hold line breaks).
function countLF(s) {
  let count = 0;
  let at = -1;
  while ((at = s.indexOf('\n', at + 1)) !== -1) count++;
  return count;
}

// Drop every '\r' from a field value, recording one stray_cr error per
// dropped CR. Returns the cleaned value.
function dropStrayCRs(value, line, row, errors) {
  const parts = value.split('\r');
  const count = parts.length - 1;
  for (let i = 0; i < count; i++) {
    errors.push({ code: 'stray_cr', line, row });
  }
  return parts.join('');
}

// Finish a record: apply the width rule (pad/cut) and record any
// short_row/long_row error, then store it.
function endRecord(fields, recStartLine, recIdx, width, rowOf, errors, records) {
  if (recIdx === 0) {
    records.push(fields);
    return fields.length;
  }
  if (fields.length < width) {
    errors.push({
      code: 'short_row',
      line: recStartLine,
      row: rowOf(recIdx),
      fields: fields.length,
    });
    while (fields.length < width) fields.push('');
  } else if (fields.length > width) {
    const extra = fields.slice(width);
    errors.push({
      code: 'long_row',
      line: recStartLine,
      row: rowOf(recIdx),
      extra,
    });
    fields.length = width;
  }
  records.push(fields);
  return width;
}

// Fast path for texts with no double quote at all: no quoted fields can
// occur, so records are whole lines split on commas. Lone CRs are still
// stray errors and still dropped.
function runNoQuotes(s, pos, header, n) {
  const errors = [];
  const records = [];
  const rowOf = (r) => (header ? (r === 0 ? null : r - 1) : r);
  let line = 1;
  let recIdx = 0;
  let width = 0;

  while (pos < n) {
    const lf = s.indexOf('\n', pos);
    const lineEnd = lf === -1 ? n : lf;
    let lineText = s.slice(pos, lineEnd);
    // A trailing CR before a real LF is the CRLF line break, not content.
    if (lf !== -1 && lineText.charCodeAt(lineText.length - 1) === CR) {
      lineText = lineText.slice(0, -1);
    }
    if (lineText.indexOf('\r') !== -1) {
      lineText = dropStrayCRs(lineText, line, rowOf(recIdx), errors);
    }
    if (lineText.length > 0) {
      const fields = lineText.split(',');
      width = endRecord(fields, line, recIdx, width, rowOf, errors, records);
      recIdx++;
    }
    // else: a line left with no characters is no record.
    if (lf === -1) break;
    line++;
    pos = lf + 1;
  }

  return assemble(records, header, errors);
}

function assemble(records, header, errors) {
  if (header) {
    return {
      columns: records.length > 0 ? records[0] : null,
      rows: records.slice(1),
      errors,
    };
  }
  return { columns: null, rows: records, errors };
}

export function run(input) {
  const header = !!input.header;
  const s = input.text;
  const n = s.length;
  let pos = 0;
  if (n > 0 && s.charCodeAt(0) === BOM) pos = 1;

  // No quotes anywhere: take the line-split fast path.
  if (s.indexOf('"', pos) === -1) return runNoQuotes(s, pos, header, n);

  const errors = [];
  const records = [];
  const rowOf = (r) => (header ? (r === 0 ? null : r - 1) : r);
  let line = 1;
  let recIdx = 0;
  let width = 0;
  // Start line of the record currently being parsed. Every error's line
  // is the line its record starts on (RULES.txt), so mid-record errors
  // (stray_cr, quote_junk, unterminated_quote) use this, not the line
  // the parser has currently reached inside a multi-line record.
  let recStartLine = 1;

  // Outer loop: one iteration per line; empty lines produce no record.
  while (pos < n) {
    const c = s.charCodeAt(pos);
    if (c === LF) {
      line++;
      pos++;
      continue;
    }
    if (c === CR) {
      if (s.charCodeAt(pos + 1) === LF) {
        line++;
        pos += 2;
        continue;
      }
      // A lone CR at a line start is dropped; the line continues.
      errors.push({ code: 'stray_cr', line, row: rowOf(recIdx) });
      pos++;
      continue;
    }

    // Parse one record.
    recStartLine = line;
    const fields = [];
    let recordDone = false;

    while (!recordDone) {
      // --- one field ---
      let value;
      if (pos >= n) {
        // Trailing comma at end of text: the last field is empty.
        value = '';
        fields.push(value);
        recordDone = true;
        break;
      }

      if (s.charCodeAt(pos) === QUOTE) {
        // --- quoted field: find its closing quote ---
        let start = pos + 1;
        let segments = null; // set when a "" escape is met
        let q = s.indexOf('"', start);
        let closed = false;
        while (q !== -1) {
          if (s.charCodeAt(q + 1) === QUOTE) {
            // Doubled quote inside: one literal quote.
            if (segments === null) segments = [];
            segments.push(s.slice(start, q));
            start = q + 2;
            q = s.indexOf('"', start);
          } else {
            closed = true;
            break;
          }
        }

        if (!closed) {
          // The quote never closes: it is a literal character and the
          // text after it is read again as unquoted. Fall through to
          // the unquoted scan with pos still at the opening quote.
          errors.push({ code: 'unterminated_quote', line: recStartLine, row: rowOf(recIdx) });
          value = readUnquoted();
          fields.push(value);
        } else {
          // Raw content between the quotes, escapes resolved.
          let raw;
          if (segments === null) {
            raw = s.slice(start, q);
          } else {
            segments.push(s.slice(start, q));
            raw = segments.join('"');
          }
          // Inside quotes each CRLF or lone CR reads as LF, and every
          // line break inside counts for the line number.
          if (raw.indexOf('\r') !== -1) {
            raw = raw.replace(/\r\n?/g, '\n');
          }
          if (raw.indexOf('\n') !== -1) {
            line += countLF(raw);
          }
          value = raw;

          // --- what follows the closing quote, up to the next comma
          // or line break, is appended as it stands (quote_junk) ---
          let jp = q + 1;
          if (jp < n) {
            const jc = s.charCodeAt(jp);
            if (jc === COMMA) {
              pos = jp;
            } else if (jc === LF) {
              pos = jp;
            } else if (jc === CR && s.charCodeAt(jp + 1) === LF) {
              pos = jp;
            } else {
              // Junk: scan to the next comma or LF.
              let comma = s.indexOf(',', jp);
              let lf = s.indexOf('\n', jp);
              let jend = n;
              if (comma !== -1 && (lf === -1 || comma < lf)) jend = comma;
              else if (lf !== -1) jend = lf;
              let junk = s.slice(jp, jend);
              // A trailing CR before the LF is the CRLF line break.
              if (jend === lf && lf !== -1 && junk.charCodeAt(junk.length - 1) === CR) {
                junk = junk.slice(0, -1);
              }
              // Lone CRs in junk are outside quotes: dropped, stray_cr.
              if (junk.indexOf('\r') !== -1) {
                junk = dropStrayCRs(junk, recStartLine, rowOf(recIdx), errors);
              }
              if (junk.length > 0) {
                errors.push({ code: 'quote_junk', line: recStartLine, row: rowOf(recIdx) });
                value += junk;
              }
              pos = jend;
            }
          } else {
            pos = n;
          }
          fields.push(value);
        }
      } else {
        // --- unquoted field ---
        value = readUnquoted();
        fields.push(value);
      }

      // --- field separator, line break, or end of text ---
      if (pos >= n) {
        recordDone = true;
      } else {
        const dc = s.charCodeAt(pos);
        if (dc === COMMA) {
          pos++;
          // next field of this record
        } else if (dc === LF) {
          line++;
          pos++;
          recordDone = true;
        } else {
          // CR here can only be the CRLF right after a closing quote.
          line++;
          pos += 2;
          recordDone = true;
        }
      }
    }

    width = endRecord(fields, recStartLine, recIdx, width, rowOf, errors, records);
    recIdx++;
  }

  return assemble(records, header, errors);

  // Read one unquoted field starting at pos (pos < n). The field runs to
  // the next comma or LF or the end of the text; a trailing CR before an
  // LF is the CRLF break, other CRs are stray and dropped. Leaves pos at
  // the delimiter (or n) and returns the field value.
  function readUnquoted() {
    let comma = s.indexOf(',', pos);
    let lf = s.indexOf('\n', pos);
    let end = n;
    if (comma !== -1 && (lf === -1 || comma < lf)) end = comma;
    else if (lf !== -1) end = lf;
    let value = s.slice(pos, end);
    if (end === lf && lf !== -1 && value.charCodeAt(value.length - 1) === CR) {
      value = value.slice(0, -1);
    }
    if (value.indexOf('\r') !== -1) {
      value = dropStrayCRs(value, recStartLine, rowOf(recIdx), errors);
    }
    pos = end;
    return value;
  }
}
