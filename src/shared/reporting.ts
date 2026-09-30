export type SmsLogRow = {
  id: string;
  to: string;
  message: string;
  status: string;
  createdAt?: string | null;
};

export type ContactCsvRow = {
  name: string;
  mobile: string;
  department?: string;
  designation?: string;
  notes?: string;
  groupName?: string;
  groupId?: string;
};

function csvEscape(value: string | number | null | undefined): string {
  const normalized = value == null ? '' : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

export function exportContactsCsv(rows: ContactCsvRow[]): string {
  const headers = ['name', 'mobile', 'department', 'designation', 'notes', 'groupName'];
  const lines = [headers.join(',')];

  for (const row of rows) {
    const values = headers.map((header) => csvEscape(row[header as keyof ContactCsvRow] ?? ''));
    lines.push(values.join(','));
  }

  return lines.join('\n');
}

export function parseContactsCsv(csv: string): ContactCsvRow[] {
  const clean = csv.trim();
  if (!clean) return [];

  const lines = clean.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((header) => header.trim().toLowerCase());
  const rows: ContactCsvRow[] = [];

  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const record: Record<string, string> = {};

    headers.forEach((header, index) => {
      record[header] = values[index] ?? '';
    });

    const row = {
      name: (record.name ?? '').trim(),
      mobile: (record.mobile ?? '').trim(),
      department: (record.department ?? '').trim(),
      designation: (record.designation ?? '').trim(),
      notes: (record.notes ?? '').trim(),
      groupName: (record.groupname ?? record.group ?? record['group name'] ?? '').trim(),
    };

    if (!row.name || !row.mobile) continue;
    rows.push(row);
  }

  return rows;
}

export function filterSmsLogs<T extends SmsLogRow>(logs: T[], filters: { year?: number; month?: number } = {}): T[] {
  return logs.filter((log) => {
    const createdAt = log.createdAt ? new Date(log.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) {
      return false;
    }

    if (filters.year != null && createdAt.getFullYear() !== Number(filters.year)) return false;
    if (filters.month != null && createdAt.getMonth() + 1 !== Number(filters.month)) return false;

    return true;
  });
}

export function exportSmsLogsCsv(rows: SmsLogRow[]): string {
  const header = ['id', 'to', 'message', 'status', 'createdAt'];
  const rowsCsv = rows.map((row) => header.map((key) => {
    const value = row[key as keyof SmsLogRow] ?? '';
    const escaped = String(value).replace(/"/g, '""');
    return `"${escaped}"`;
  }).join(','));

  return [header.join(','), ...rowsCsv].join('\n');
}
