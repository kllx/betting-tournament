import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BetsModule } from "./bets/bets.module";
import configuration from "./config/configuration";
import { BetEntity } from "./database/entities/bet.entity";
import { PlayerEntity } from "./database/entities/player.entity";
import { SecurityHardening } from "./database/migrations/AddEventSecurity";
import { TournamentFinalization } from "./database/migrations/AddPayoutLedger";
import { ReviewHardening } from "./database/migrations/AddScoreRevisions";
import { StorageRetention } from "./database/migrations/AddStorageRetention";
import { ArchiveRetention } from "./database/migrations/AddArchiveRetention";
import { DedupRetention } from "./database/migrations/AddDedupRetention";
import { TournamentState } from "./database/migrations/AddTournamentLifecycle";
import { InitialSchema } from "./database/migrations/CreateBettingSchema";
import { OptimizeHotPaths } from "./database/migrations/OptimizeHotPaths";
import { RetentionModule } from "./database/retention.module";
import { LeaderboardModule } from "./leaderboard/leaderboard.module";
import { ObservabilityModule } from "./observability/observability.module";
import { TournamentModule } from "./tournament/tournament.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres" as const,
        url: config.getOrThrow<string>("databaseUrl"),
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
        migrationsRun: config.getOrThrow<boolean>("databaseMigrationsRun"),
        migrationsTransactionMode: "each",
        synchronize: false,
      }),
    }),
    ObservabilityModule,
    TournamentModule,
    BetsModule,
    LeaderboardModule,
    RetentionModule,
  ],
})
export class AppModule {}
