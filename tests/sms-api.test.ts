import { describe, expect, it } from 'vitest';
import { buildDhiraaguXmlVariants, parseDhiraaguStatus } from '../electron/ipc/setup.ipc';

describe('Dhiraagu XML API helpers', () => {
  it('builds the expected Dhiraagu message XML payload', () => {
    const xml = buildDhiraaguXmlVariants({ username: 'addu', password: 'secret', sender: 'adducouncil', to: '9990166', text: 'Test Message, please ignore.' })[0];
    expect(xml).toContain('<TELEMESSAGE>');
    expect(xml).toContain('<SUBJECT>adducouncil</SUBJECT>');
    expect(xml).toContain('<USER_NAME>addu</USER_NAME>');
    expect(xml).toContain('<PASSWORD>secret</PASSWORD>');
    expect(xml).toContain('<DEVICE_TYPE DEVICE_TYPE="SMS"/>');
    expect(xml).toContain('<DEVICE_VALUE>9990166</DEVICE_VALUE>');
    expect(xml).toContain('<TEXT>Test Message, please ignore.</TEXT>');
    expect(xml).toContain('<VERSION>1.6</VERSION>');
  });

  it('parses message_id and message_key from the provider response', () => {
    const output = `<?xml version="1.0" encoding="UTF-8"?><RESPONSE><message_id>77339431</message_id><message_key>933632706492826821420474656539</message_key></RESPONSE>`;
    expect(parseDhiraaguStatus(output)).toEqual({
      messageId: '77339431',
      messageKey: '933632706492826821420474656539',
    });
  });

  it('accepts alternate provider casing and separators in the response tags', () => {
    const output = `<?xml version="1.0" encoding="UTF-8"?><RESPONSE><MESSAGE-ID>77339432</MESSAGE-ID><MESSAGE-KEY>abc123</MESSAGE-KEY></RESPONSE>`;
    expect(parseDhiraaguStatus(output)).toEqual({
      messageId: '77339432',
      messageKey: 'abc123',
    });
  });
});
