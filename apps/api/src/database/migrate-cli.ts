import { loadConfig } from '../config/config';
import { DatabaseService } from './database.service';

async function main() {
  const db = new DatabaseService(loadConfig());
  const applied = await db.migrate();
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema up to date');
  await db.onModuleDestroy();
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
