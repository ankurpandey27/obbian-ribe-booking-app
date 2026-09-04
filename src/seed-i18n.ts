/**
 * I18N seed — idempotent upsert of all backend-managed message strings.
 * Re-runnable. Run after seed-catalog:
 *
 *   ts-node src/seed-i18n.ts
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { messageCatalog } from './common/database/schema';

loadEnv();

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5433/ride_booking',
});
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
const db = drizzle(pool, { schema: { messageCatalog } });

const MESSAGES: Array<{
  key: string;
  scope?: string;
  message: Record<string, string>;
  description?: string;
}> = [
  // ── Ride lifecycle ──────────────────────────────────────────────────────
  {
    key: 'ride.status.dispatched',
    message: {
      'en-IN': 'Driver is on the way',
      'hi-IN': 'ड्राइवर आ रहा है',
      'te-IN': 'డ్రైవర్ వస్తున్నాడు',
    },
    description: 'Shown when driver accepts and heads to pickup',
  },
  {
    key: 'ride.status.arrived',
    message: {
      'en-IN': 'Driver has arrived',
      'hi-IN': 'ड्राइवर पहुँच गया',
      'te-IN': 'డ్రైవర్ చేరుకున్నాడు',
    },
  },
  {
    key: 'ride.status.started',
    message: {
      'en-IN': 'Trip started',
      'hi-IN': 'सफ़र शुरू',
      'te-IN': 'ప్రయాణం మొదలైంది',
    },
  },
  {
    key: 'ride.status.completed',
    message: {
      'en-IN': 'Trip completed. Thanks for riding!',
      'hi-IN': 'सफ़र पूरा हुआ। सवारी के लिए धन्यवाद!',
      'te-IN': 'ప్రయాణం పూర్తయింది. రైడ్ చేసినందుకు ధన్యవాదాలు!',
    },
  },
  {
    key: 'ride.status.cancelled',
    message: {
      'en-IN': 'Ride cancelled',
      'hi-IN': 'सवारी रद्द',
      'te-IN': 'రైడ్ రద్దు చేయబడింది',
    },
  },
  {
    key: 'ride.pickup_code',
    message: {
      'en-IN': 'Your pickup code is {code}. Share it with your driver.',
      'hi-IN': 'आपका पिकअप कोड {code} है। इसे अपने ड्राइवर को बताएँ।',
      'te-IN': 'మీ పికప్ కోడ్ {code}. దీన్ని మీ డ్రైవర్‌కు చెప్పండి.',
    },
    description: 'Boarding code shown to rider',
  },
  {
    key: 'ride.code_invalid',
    message: {
      'en-IN': 'Invalid code. Ask the rider for the current code.',
      'hi-IN': 'गलत कोड। राइडर से वर्तमान कोड पूछें।',
      'te-IN': 'కోడ్ తప్పు. రైడర్ నుండి ప్రస్తుత కోడ్ అడగండి.',
    },
  },
  {
    key: 'ride.code_exhausted',
    message: {
      'en-IN': 'Too many attempts. Driver must re-arrive to get a new code.',
      'hi-IN':
        'बहुत अधिक प्रयास। नया कोड पाने के लिए ड्राइवर को फिर से आना होगा।',
      'te-IN': 'చాలా ప్రయత్నాలు. కొత్త కోడ్ ప�ందడానికి డ్రైవర్ మళ్లీ రావాలి.',
    },
  },
  // ── Errors ─────────────────────────────────────────────────────────────
  {
    key: 'error.no_drivers',
    message: {
      'en-IN': 'No drivers available right now. Want me to try again?',
      'hi-IN': 'अभी कोई ड्राइवर उपलब्ध नहीं है। फिर से कोशिश करें?',
      'te-IN': 'ప్రస్తుతం డ్రైవర్లు అందుబాటులో లేరు. మళ్లీ ప్రయత్నించాలా?',
    },
  },
  {
    key: 'error.payment_failed',
    message: {
      'en-IN':
        "The payment couldn't be completed. Please update your payment method and try again.",
      'hi-IN':
        'भुगतान पूरा नहीं हो सका। कृपया भुगतान विधि अपडेट करें और फिर कोशिश करें।',
      'te-IN':
        'చెల్లింపు పూర్తి కాలేదు. దయచేసి చెల్లింపు పద్ధతిని నవీకరించి మళ్లీ ప్రయత్నించండి.',
    },
  },
  {
    key: 'error.generic',
    message: {
      'en-IN': 'Something went wrong. Please try again.',
      'hi-IN': 'कुछ गड़बड़ हो गई। कृपया पुनः प्रयास करें।',
      'te-IN': 'ఏదో తప్పు జరిగింది. దయచేసి మళ్లీ ప్రయత్నించండి.',
    },
  },
  // ── Cancellation ────────────────────────────────────────────────────────
  {
    key: 'cancel.success',
    message: {
      'en-IN': 'Your ride has been cancelled.',
      'hi-IN': 'आपकी सवारी रद्द कर दी गई है।',
      'te-IN': 'మీ రైడ్ రద్దు చేయబడింది.',
    },
  },
  {
    key: 'cancel.fee_applied',
    message: {
      'en-IN': 'A cancellation fee of ₹{fee} has been applied.',
      'hi-IN': '₹{fee} का रद्द शुल्क लगाया गया है।',
      'te-IN': 'రద్దు రుసుము ₹{fee} వర్తించబడింది.',
    },
  },
];

async function seed() {
  console.log('Seeding i18n messages...');
  for (const msg of MESSAGES) {
    await db
      .insert(messageCatalog)
      .values({
        key: msg.key,
        scope: msg.scope ?? 'global',
        message: msg.message,
        description: msg.description,
      })
      .onConflictDoUpdate({
        target: messageCatalog.key,
        set: {
          message: msg.message,
          scope: msg.scope ?? 'global',
          description: msg.description,
          updatedAt: new Date(),
        },
      });
    console.log(`  upserted: ${msg.key}`);
  }
  console.log(`I18n seed complete: ${MESSAGES.length} keys.`);
  await pool.end();
}

seed().catch((err) => {
  console.error('I18n seed failed:', err);
  process.exit(1);
});
