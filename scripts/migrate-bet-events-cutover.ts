import dataSource from "../src/database/data-source";
import { cutoverBetEvents } from "../src/database/migrations/AddStorageRetention";

async function main(): Promise<void> {
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  try {
    await queryRunner.connect();
    await cutoverBetEvents(queryRunner);
    process.stdout.write("Bet events cutover completed\n");
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
