import { describe, expect, it } from 'vitest';
import { exportContactsCsv, exportSmsLogsCsv, filterSmsLogs, parseContactsCsv } from '../src/shared/reporting';

describe('sms reporting', () => {
  const logs = [
    { id: '1', to: '9607712345', message: 'A', status: 'delivered', createdAt: '2024-01-15T10:00:00.000Z' },
    { id: '2', to: '9607712346', message: 'B', status: 'failed', createdAt: '2025-02-10T12:00:00.000Z' },
    { id: '3', to: '9607712347', message: 'C', status: 'sent', createdAt: '2025-03-11T08:00:00.000Z' },
    { id: '4', to: '9607712348', message: 'D', status: 'queued', createdAt: '2025-03-15T09:00:00.000Z' },
  ];

  it('filters logs by year only', () => {
    expect(filterSmsLogs(logs, { year: 2025 }).map((item) => item.id)).toEqual(['2', '3', '4']);
  });

  it('filters logs by year and month', () => {
    expect(filterSmsLogs(logs, { year: 2025, month: 3 }).map((item) => item.id)).toEqual(['3', '4']);
  });

  it('exports csv rows with headers', () => {
    const csv = exportSmsLogsCsv(logs.slice(0, 2));
    expect(csv).toContain('id,to,message,status,createdAt');
    expect(csv).toContain('9607712345');
    expect(csv).toContain('2024-01-15T10:00:00.000Z');
  });

  it('exports contact rows as csv', () => {
    const csv = exportContactsCsv([
      { name: 'Aisha', mobile: '9607712345', department: 'Admin', designation: 'Officer', notes: 'VIP', groupName: 'Staff' },
    ]);
    expect(csv).toContain('name,mobile,department,designation,notes,groupName');
    expect(csv).toContain('Aisha');
    expect(csv).toContain('Staff');
  });

  it('parses contact csv rows into normalized entries', () => {
    const csv = `name,mobile,department,designation,notes,groupName\nAisha,9607712345,Admin,Officer,VIP,Staff\n`;
    expect(parseContactsCsv(csv)).toEqual([
      { name: 'Aisha', mobile: '9607712345', department: 'Admin', designation: 'Officer', notes: 'VIP', groupName: 'Staff' },
    ]);
  });
});
