export function preserveJsonNumbers(raw: string, fields?: string[]): string {
  const monetaryFields = fields ? new Set(fields) : undefined;
  let output = "";
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== '"') {
      if (!monetaryFields) {
        const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
          raw.slice(index),
        );
        if (number) {
          output += JSON.stringify(number[0]);
          index += number[0].length;
          continue;
        }
      }
      output += raw[index];
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (raw[index - 1] === '"') {
        break;
      }
    }
    const token = raw.slice(start, index);
    output += token;
    const key = JSON.parse(token) as string;
    let cursor = index;
    while (/\s/.test(raw[cursor] ?? "")) {
      cursor += 1;
    }
    if (
      raw[cursor] !== ":" ||
      (monetaryFields !== undefined && !monetaryFields.has(key))
    ) {
      continue;
    }
    output += raw.slice(index, cursor + 1);
    index = cursor + 1;
    while (/\s/.test(raw[index] ?? "")) {
      output += raw[index];
      index += 1;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      raw.slice(index),
    );
    if (number) {
      output += JSON.stringify(number[0]);
      index += number[0].length;
    }
  }
  return output;
}
