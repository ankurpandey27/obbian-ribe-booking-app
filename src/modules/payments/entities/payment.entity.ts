import { payments } from '../../../common/database/schema';

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
