# Rider & Driver Ride Flow — API Walkthrough

Base URL: `https://obbian-ribe-booking-app-2.onrender.com/api/v1`

Auth: everything except `auth/*`, `health`, `maps/*`, `rides/quote`, `payments/webhook` needs
`Authorization: Bearer <accessToken>`. Access tokens last **15 minutes** — refresh via
`POST /auth/refresh` or re-verify OTP.

---

## Ride lifecycle (state machine)

```
REQUESTED ──► MATCHING ──► ACCEPTED ──► ARRIVED ──► IN_PROGRESS ──► COMPLETED
    │            │            │             │              │
    └────────────┴────────────┴─────────────┴──────────────┴──► CANCELLED
            (cancel allowed at any stage before COMPLETED)
```

- `REQUESTED` — rider submitted the ride
- `MATCHING` — system is scanning the driver geo pool
- `ACCEPTED` — a driver accepted (first accept wins, hedged offers)
- `ARRIVED` — driver reached the pickup point
- `IN_PROGRESS` — trip started
- `COMPLETED` — trip finished, final fare computed

---

## Rider flow (search → book → ride)

### Step 0 — Login (once)
```
POST /auth/send-otp     { "phone": "+919000000000" }
POST /auth/verify-otp   { "phone": "+919000000000", "otp": "123456" }
```
→ `{ "accessToken": "...", "refreshToken": "..." }` — send `accessToken` on every ride call.

### Step 1 — Get a fare quote (public, no token)
```
GET /rides/quote?pickupLat=28.7041&pickupLon=77.1025
                 &dropoffLat=28.5355&dropoffLon=77.391
                 &city=Delhi&rideType=AUTO
```
→ `{ options: [{ rideType, fare, surgeMultiplier, etaMin, ... }], polyline, surgeMultiplier }`

Shows the rider every ride type + price **before booking**. The quote shown here is the
price-lock used at request time.

### Step 2 — Request the ride
```
POST /rides/request
Authorization: Bearer <token>
{
  "pickupLat": 28.7041,  "pickupLon": 77.1025,
  "dropoffLat": 28.5355, "dropoffLon": 77.391,
  "rideType": "AUTO",
  "city": "Delhi"
}
```
→ `{ rideId, estimatedFare, surgeMultiplier, payableFare, estimatedTime, status: "REQUESTED", driverId: null }`

The fare is **price-locked** against the quote (surge included). Status moves to `MATCHING`
while the system searches drivers near the pickup.

### Step 3 — Poll for the driver
```
GET /rides/active          → active ride(s) for this rider
GET /rides/:rideId         → single ride + driverId once assigned
```
When matched: `status: "ACCEPTED"`, `driverId: "b0e2a3f4-..."`.
Optional: `GET /drivers/:driverId` to show the rider the driver's vehicle/rating.

### Step 4 — Track the driver's arrival
```
GET /rides/:rideId/tracking   → { driver: { lat, lon }, route: [...], eta }
GET /rides/:rideId/eta        → cached ETA + distance (30s cache)
```
Rider watches the driver approach. When the driver taps **arrived**, the rider's poll shows
`status: "ARRIVED"`.

### Step 5 — Ride in progress
Driver taps **start** → `status: "IN_PROGRESS"`. Rider can keep polling
`GET /rides/:rideId` / tracking during the trip.

### Step 6 — Trip done
Driver taps **complete** → `status: "COMPLETED"`, response includes `totalFare`
(final fare). Rider confirms via `GET /rides/:rideId` (now has `totalFare`,
`completedAt`).

---

## Driver flow (go online → accept → pickup → drop off)

### Step 0 — Onboard (once)
```
POST /drivers/register        (any authenticated user)
Authorization: Bearer <token>
{
  "licenseNumber": "DL-04201145678",
  "vehicleRegistration": "DL-01-CA-1234",
  "vehicleModel": "Maruti Suzuki Dzire",
  "vehicleColor": "White",
  "vehicleType": "CABX_SAVER",
  "upiId": "upi@bank"
}
```
→ profile linked to your account; **re-verify OTP** (`POST /auth/verify-otp`) to get a new
token with `role: DRIVER` — required for driver endpoints below.

### Step 1 — Go online
```
PUT /drivers/status
Authorization: Bearer <token> (role: DRIVER)
{ "status": "ONLINE" }
```
Only `ONLINE` drivers are visible to the matcher.

### Step 2 — Push live location (heartbeat, 3–5s)
```
POST /drivers/location
{ "lat": 28.7041, "lon": 77.1025, "timestamp": 1723123456789 }
```
Keeps you in the Redis geo pool (this is how the matcher finds you).
→ `{ updated: true }` — if the jump looks impossible you get
`{ updated: false, reason: "IMPLAUSIBLE_JUMP" }`.

### Step 3 — Receive & accept a ride offer
The matching worker scans the geo pool near the pickup and fires hedged offers (all
candidates at once, **30s offer TTL**, first accept wins). Drivers receive the offer via the
event bus (`ride_offered`); in a REST-only setup, poll `GET /rides/active` or watch for
the offer notification.

```
POST /drivers/accept-ride
{ "rideId": "ride-uuid" }
```
→ `{ accepted: true, message: "Ride accepted" }` — atomic: if another driver already won,
you get `{ accepted: false, message: "Ride already taken by another driver" }`.

Reject instead: `POST /drivers/reject-ride { "rideId": "...", "reason": "Pickup too far" }`

### Step 4 — Drive to the pickup
```
GET /rides/:rideId        → pickup/dropoff coords, rider info
GET /rides/:rideId/tracking → route polyline
```
Navigate to the pickup. Tap **arrived** at the point:
```
POST /drivers/rides/:rideId/arrived
```
→ `{ status: "ARRIVED" }` — the rider now sees you on the way/arrived.
(403 `Ride is not assigned to this driver` if you act on a ride that isn't yours.)

### Step 5 — Start the trip
```
POST /drivers/rides/:rideId/start
```
→ `{ status: "IN_PROGRESS" }` — rider gets picked up.

### Step 6 — Complete the trip
```
POST /drivers/rides/:rideId/complete
```
→ `{ status: "COMPLETED", totalFare: 718.5 }` — final fare computed and locked.
Go back online via `PUT /drivers/status { "status": "ONLINE" }` to receive the next offer.

---

## Cancellation (either side, any stage before completion)
```
PUT /rides/:rideId/cancel
{
  "reason": "USER_CANCELLED" | "DRIVER_CANCELLED" | "NO_DRIVER_FOUND" | "SYSTEM",
  "cancelledBy": "RIDER" | "DRIVER" | "SYSTEM"
}
```
→ `{ success: true, refundAmount: 0, status: "CANCELLED" }`

---

## Key facts
- Quote → request is **price-locked** (surge at quote time applies at completion).
- Matching: hedged offers, 30s TTL, atomic accept — no double-booking.
- Tracking ETA is cached 30s; driver location is a best-effort 3–5s heartbeat.
- Access token TTL is 15 min — `POST /auth/refresh` with the refresh token before it dies.
