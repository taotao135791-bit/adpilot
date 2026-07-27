function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  row.push(value);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function summarize(rows) {
  if (rows.length === 0) {
    return { rowCount: 0, columns: [], numericTotals: {} };
  }
  const columns = rows[0].map((name, index) => name.trim() || `column_${index + 1}`);
  const numericTotals = {};
  const numericCounts = {};
  for (const row of rows.slice(1)) {
    for (let index = 0; index < columns.length; index += 1) {
      const raw = row[index]?.trim() ?? "";
      if (raw === "") continue;
      const number = Number(raw);
      if (!Number.isFinite(number)) continue;
      const column = columns[index];
      numericTotals[column] = (numericTotals[column] ?? 0) + number;
      numericCounts[column] = (numericCounts[column] ?? 0) + 1;
    }
  }
  return {
    rowCount: Math.max(0, rows.length - 1),
    columns,
    numericTotals,
    numericCounts
  };
}

export const tools = Object.freeze({
  "com.adpilot.csv-daily-report/summarize": async (input, runtime) => {
    if (!input || typeof input !== "object" || typeof input.path !== "string") {
      throw new Error("input.path is required");
    }
    const delimiter =
      typeof input.delimiter === "string" && input.delimiter.length === 1
        ? input.delimiter
        : ",";
    const text = await runtime.capabilities.call("filesystem.readText", {
      path: input.path,
      maxBytes: 1000000
    });
    return summarize(parseCsv(text, delimiter));
  }
});
