import { describe, it, expect } from 'bun:test';
import { parseIcal, icalDateToIso, icalDateYear, parseEarlyCloseFromDescription } from '../ical-parser.ts';

// Realistic NYSE iCal fixture — captured from the live feed structure. Full closures
// + half-days both represented; CRLF line endings + a continuation line included.
const NYSE_ICAL_FIXTURE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//NYSE//Holidays_and_Hours//EN',
  'BEGIN:VEVENT',
  'SUMMARY:Christmas Day',
  'DTSTART;VALUE=DATE:20261225',
  'DESCRIPTION:NYSE will be closed in observance of Christmas Day.',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Day after Thanksgiving',
  'DTSTART;VALUE=DATE:20261127',
  'DESCRIPTION:NYSE will close early at 1:00 PM ET on this day.',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Christmas Eve',
  'DTSTART;VALUE=DATE:20261224',
  'DESCRIPTION:NYSE will close',
  '  early at 1:00 PM ET.',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcal', () => {
  it('parses VEVENT blocks with DTSTART, SUMMARY, DESCRIPTION', () => {
    const events = parseIcal(NYSE_ICAL_FIXTURE);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      dtStart:     '20261225',
      summary:     'Christmas Day',
      description: 'NYSE will be closed in observance of Christmas Day.',
    });
  });

  it('handles RFC 5545 line continuation (folded long descriptions)', () => {
    const events = parseIcal(NYSE_ICAL_FIXTURE);
    const xmasEve = events.find((e) => e.summary === 'Christmas Eve')!;
    expect(xmasEve.description).toBe('NYSE will close early at 1:00 PM ET.');
  });

  it('throws on RRULE inside VEVENT (shape-change canary)', () => {
    const bad = [
      'BEGIN:VEVENT',
      'SUMMARY:Recurring',
      'DTSTART;VALUE=DATE:20260101',
      'RRULE:FREQ=YEARLY',
      'END:VEVENT',
    ].join('\r\n');
    expect(() => parseIcal(bad)).toThrow('unsupported recurrence property');
  });

  it('throws on EXDATE inside VEVENT', () => {
    const bad = [
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20260101',
      'EXDATE;VALUE=DATE:20270101',
      'END:VEVENT',
    ].join('\r\n');
    expect(() => parseIcal(bad)).toThrow('unsupported recurrence property');
  });

  it('throws on unsupported DTSTART form (datetime instead of DATE)', () => {
    const bad = [
      'BEGIN:VEVENT',
      'DTSTART:20260101T140000Z',
      'END:VEVENT',
    ].join('\r\n');
    expect(() => parseIcal(bad)).toThrow('unsupported DTSTART form');
  });

  it('skips lines outside VEVENT', () => {
    const events = parseIcal(NYSE_ICAL_FIXTURE);
    // VCALENDAR-level fields (VERSION, PRODID) don't appear as events.
    expect(events.every((e) => e.dtStart.length === 8)).toBe(true);
  });

  it('handles empty input gracefully', () => {
    expect(parseIcal('')).toEqual([]);
  });
});

describe('icalDateToIso / icalDateYear', () => {
  it('converts YYYYMMDD to YYYY-MM-DD', () => {
    expect(icalDateToIso('20261225')).toBe('2026-12-25');
  });
  it('extracts year', () => {
    expect(icalDateYear('20261225')).toBe(2026);
  });
});

describe('parseEarlyCloseFromDescription', () => {
  it('extracts 13:00 from "1:00 PM ET"', () => {
    expect(parseEarlyCloseFromDescription('NYSE will close early at 1:00 PM ET.')).toBe('13:00');
  });
  it('extracts 11:30 from "11:30 AM"', () => {
    expect(parseEarlyCloseFromDescription('Closes 11:30 AM ET.')).toBe('11:30');
  });
  it('extracts 12:00 from "12:00 PM" (noon)', () => {
    expect(parseEarlyCloseFromDescription('Closes 12:00 PM.')).toBe('12:00');
  });
  it('extracts 00:00 from "12:00 AM" (midnight)', () => {
    expect(parseEarlyCloseFromDescription('Closes 12:00 AM.')).toBe('00:00');
  });
  it('returns null when description has no time', () => {
    expect(parseEarlyCloseFromDescription('Markets closed for holiday.')).toBeNull();
  });
  it('returns null for empty description', () => {
    expect(parseEarlyCloseFromDescription('')).toBeNull();
  });
});
