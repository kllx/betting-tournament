import { Module } from "@nestjs/common";
import { StorageRetentionService } from "./retention.service";

@Module({
  providers: [StorageRetentionService],
})
export class RetentionModule {}
