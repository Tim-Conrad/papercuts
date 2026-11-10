// TOON at the output boundary (https://axi.md). The internal data stays plain JS objects.

function cell(value) {
  if (value === null) return 'null';
  if (value === undefined) return '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  if (text === '' || /[,"\n{}:]/.test(text) || text.trim() !== text) return JSON.stringify(text);
  return text;
}

// After "key: " a value only needs quotes when it is empty, has a newline or edge spaces.
function scalar(value) {
  if (typeof value !== 'string') return cell(value);
  if (value === '' || /\n/.test(value) || value.trim() !== value) return JSON.stringify(value);
  return value;
}

function lines(key, value, indent) {
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}${key}[0]:`];
    if (value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      const fields = [...new Set(value.flatMap((v) => Object.keys(v)))];
      return [`${indent}${key}[${value.length}]{${fields.join(',')}}:`,
        ...value.map((row) => `${indent}  ${fields.map((f) => cell(row[f])).join(',')}`)];
    }
    // A list of scalars: one per line, so that a help line keeps its commas.
    return [`${indent}${key}[${value.length}]:`, ...value.map((v) => `${indent}  ${typeof v === 'string' ? v : cell(v)}`)];
  }
  if (value && typeof value === 'object') {
    return [`${indent}${key}:`, ...Object.entries(value).flatMap(([k, v]) => lines(k, v, indent + '  '))];
  }
  return [`${indent}${key}: ${scalar(value)}`];
}

export function toon(obj) {
  return Object.entries(obj).flatMap(([k, v]) => lines(k, v, '')).join('\n');
}
