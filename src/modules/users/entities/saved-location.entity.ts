import { savedLocations } from '../../../common/database/schema';

export type SavedLocation = typeof savedLocations.$inferSelect;
export type NewSavedLocation = typeof savedLocations.$inferInsert;
