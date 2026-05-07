# PhpStorm Setup

This project is prepared to work well from PhpStorm with the source code living in WSL and MySQL running in Docker.

## Open the project

Open the project from the WSL path:

- `\\wsl$\Ubuntu-20.04\home\sevastia\MedfinDataCloud`

## Recommended interpreter

Set the project Node interpreter to the WSL Node installation:

- WSL distribution: `Ubuntu-20.04`
- Node path: `/home/sevastia/.nvm/versions/node/v22.12.0/bin/node`
- npm path: `/home/sevastia/.nvm/versions/node/v22.12.0/bin/npm`

The project also includes `.nvmrc` with `v22.12.0`.

## Environment files

Use these files depending on how you run the app:

- `.env`
  - for PhpStorm and direct WSL execution
  - uses `127.0.0.1:3306` for MySQL
- `.env.docker`
  - for Docker Compose
  - uses `mysql:3306` as the database host

## Shared run configurations

The repository includes shared JetBrains run configs in `.run/`:

- `Start Dev Server`
- `Build`
- `Prisma Generate`
- `Prisma Push`

After selecting the WSL Node interpreter, these run configs should work inside PhpStorm.

## Suggested PhpStorm services setup

1. Start the database only:
   - `docker compose up -d mysql`
2. In PhpStorm run:
   - `Prisma Generate`
   - `Prisma Push`
   - `Start Dev Server`

This keeps the Nest app running inside the IDE while MySQL runs in Docker.

## Prisma

Recommended Prisma plugin settings:

- schema file: `prisma/schema.prisma`

If PhpStorm asks for environment variables, the app uses `.env` by default.

## HTTP and Swagger

When the app is running from PhpStorm:

- API base URL: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs`

## Database connection in PhpStorm

If you want a PhpStorm database connection, use:

- Host: `127.0.0.1`
- Port: `3306`
- Database: `datacloud`
- User: `datacloud`
- Password: `datacloud`

## Current limitation

Docker is not currently available inside this WSL distro, so the intended workflow is:

- edit and run NestJS from PhpStorm in WSL
- run MySQL through Docker Desktop with WSL integration or from Windows Docker
