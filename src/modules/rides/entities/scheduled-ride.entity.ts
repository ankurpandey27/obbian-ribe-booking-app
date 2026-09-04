import { scheduledRides } from '../../../common/database/schema';

export type ScheduledRide = typeof scheduledRides.$inferSelect;
export type NewScheduledRide = typeof scheduledRides.$inferInsert;
