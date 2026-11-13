import { DataSource } from "typeorm";
import configuration from "../config/configuration";
import { BetEntity } from "./entities/bet.entity";
import { PlayerEntity } from "./entities/player.entity";
import { SecurityHardening } from "./migrations/AddEventSecurity";
import { TournamentFinalization } from "./migrations/AddPayoutLedger";
import { ReviewHardening } from "./migrations/AddScoreRevisions";
import { StorageRetention } from "./migrations/AddStorageRetention";
import { ArchiveRetention } from "./migrations/AddArchiveRetention";
import { DedupRetention } from "./migrations/AddDedupRetention";
import { TournamentState } from "./migrations/AddTournamentLifecycle";
import { InitialSchema } from "./migrations/CreateBettingSchema";
import { OptimizeHotPaths } from "./migrations/OptimizeHotPaths";

export default new DataSource({
  type: "postgres",
  url: configuration().databaseUrl,
  entities: [BetEntity, PlayerEntity],
  migrations: [
    InitialSchema,
    TournamentState,
    TournamentFinalization,
    SecurityHardening,
    ReviewHardening,
    StorageRetention,
    OptimizeHotPaths,
    DedupRetention,
    ArchiveRetention,
  ],
  migrationsTransactionMode: "each",
  synchronize: false,
});
