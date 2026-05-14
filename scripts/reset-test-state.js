const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  await prisma.syncRun.deleteMany();
  await prisma.entitySyncState.deleteMany();
  await prisma.repositoryRecord.deleteMany();
  console.log('Cleared syncRun, entitySyncState, repositoryRecord');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
