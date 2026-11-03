/**
 * RoomStore on Durable Object SQLite. Calls are synchronous, so a handler's
 * writes (insert segment + bump room rev) commit together.
 */
import type { RoomRecord, RoomStore } from '@saybeam/protocol/room';
import type { Segment } from '@saybeam/protocol';

type SegmentRow = {
  seq: number;
  id: string;
  text: string;
  ts: number;
  rev: number;
  start_ms: number | null;
  end_ms: number | null;
  edited: number;
};

const COLUMNS = 'seq, id, text, ts, rev, start_ms, end_ms, edited';

/** True when this object already holds a room (reading does not create storage). */
export function hasSchema(sql: SqlStorage): boolean {
  return sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room'").toArray().length > 0;
}

export function migrate(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS room (
      k INTEGER PRIMARY KEY CHECK (k = 1),
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS segments (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL,
      rev INTEGER NOT NULL,
      start_ms INTEGER,
      end_ms INTEGER,
      edited INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS segments_rev ON segments(rev);
  `);
}

function toSegment(row: SegmentRow): Segment {
  return {
    seq: row.seq,
    id: row.id,
    text: row.text,
    ts: row.ts,
    rev: row.rev,
    ...(row.start_ms !== null ? { startMs: row.start_ms } : {}),
    ...(row.end_ms !== null ? { endMs: row.end_ms } : {}),
    ...(row.edited ? { edited: true } : {}),
  };
}

export class SqlRoomStore implements RoomStore {
  private readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
  }

  transaction(fn: () => void): void {
    this.storage.transactionSync(fn);
  }

  loadRoom(): RoomRecord | null {
    const row = this.sql.exec<{ data: string }>('SELECT data FROM room WHERE k = 1').toArray()[0];
    return row ? (JSON.parse(row.data) as RoomRecord) : null;
  }

  saveRoom(room: RoomRecord): void {
    this.sql.exec('INSERT INTO room (k, data) VALUES (1, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data', JSON.stringify(room));
  }

  insertSegment(seg: Segment): void {
    this.sql.exec(
      `INSERT INTO segments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      seg.seq,
      seg.id,
      seg.text,
      seg.ts,
      seg.rev,
      seg.startMs ?? null,
      seg.endMs ?? null,
      seg.edited ? 1 : 0,
    );
  }

  replaceSegment(seg: Segment): void {
    this.sql.exec('UPDATE segments SET text = ?, rev = ?, edited = ? WHERE seq = ?', seg.text, seg.rev, seg.edited ? 1 : 0, seg.seq);
  }

  getSegment(seq: number): Segment | null {
    const row = this.sql.exec<SegmentRow>(`SELECT ${COLUMNS} FROM segments WHERE seq = ?`, seq).toArray()[0];
    return row ? toSegment(row) : null;
  }

  findSegmentById(id: string): Segment | null {
    const row = this.sql.exec<SegmentRow>(`SELECT ${COLUMNS} FROM segments WHERE id = ?`, id).toArray()[0];
    return row ? toSegment(row) : null;
  }

  countChangedSince(rev: number): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM segments WHERE rev > ?', rev).one().n;
  }

  changedSince(rev: number): Segment[] {
    return this.sql.exec<SegmentRow>(`SELECT ${COLUMNS} FROM segments WHERE rev > ? ORDER BY seq ASC`, rev).toArray().map(toSegment);
  }

  latest(limit: number): Segment[] {
    return this.sql.exec<SegmentRow>(`SELECT ${COLUMNS} FROM segments ORDER BY seq DESC LIMIT ?`, limit).toArray().map(toSegment).reverse();
  }

  before(before: number, limit: number): Segment[] {
    return this.sql.exec<SegmentRow>(`SELECT ${COLUMNS} FROM segments WHERE seq < ? ORDER BY seq DESC LIMIT ?`, before, limit).toArray().map(toSegment).reverse();
  }

  firstSeq(): number | null {
    const row = this.sql.exec<{ seq: number | null }>('SELECT MIN(seq) AS seq FROM segments').one();
    return row.seq ?? null;
  }
}
