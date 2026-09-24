/**
 * Client-generated ids (Zero creates rows optimistically, so ids never come from the database).
 * Time-sortable: 12 hex chars of milliseconds + 20 random hex chars (UUIDv7-like, compact).
 */
export function newId(): string {
  const time = Date.now().toString(16).padStart(12, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let rand = "";
  for (const b of bytes) rand += b.toString(16).padStart(2, "0");
  return time + rand;
}
