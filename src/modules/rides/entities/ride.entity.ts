import { rides } from '../../../common/database/schema';

export type Ride = typeof rides.$inferSelect;
export type NewRide = typeof rides.$inferInsert;
