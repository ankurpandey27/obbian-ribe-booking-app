import { fareConfigs } from '../../../common/database/schema';

export type FareConfig = typeof fareConfigs.$inferSelect;
export type NewFareConfig = typeof fareConfigs.$inferInsert;
