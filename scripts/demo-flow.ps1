# Demo flow: rider login -> quote -> request -> matched -> driver accepts
# Usage: powershell -File scripts/demo-flow.ps1 [-City Bangalore] [-RideType CABX]
param(
    [string]$City = 'Bangalore',
    [string]$RideType = 'CABX'
)

$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3000/api/v1'

# demo accounts are derived from the seed (see npm run seed output)
$cities = @{
    Delhi     = @{ Rider = '+919000000000'; Driver = '+919010000000'; Lat = 28.6139; Lon = 77.2090 }
    Noida     = @{ Rider = '+919000000002'; Driver = '+919010000006'; Lat = 28.5355; Lon = 77.3910 }
    Gurugram  = @{ Rider = '+919000000004'; Driver = '+919010000010'; Lat = 28.4595; Lon = 77.0266 }
    Bangalore = @{ Rider = '+919000000006'; Driver = '+919010000013'; Lat = 12.9716; Lon = 77.5946 }
    Mumbai    = @{ Rider = '+919000000008'; Driver = '+919010000019'; Lat = 19.0760; Lon = 72.8777 }
    Hyderabad = @{ Rider = '+919000000010'; Driver = '+919010000023'; Lat = 17.3850; Lon = 78.4867 }
    Pune      = @{ Rider = '+919000000012'; Driver = '+919010000027'; Lat = 18.5204; Lon = 73.8567 }
    Chennai   = @{ Rider = '+919000000014'; Driver = '+919010000030'; Lat = 13.0827; Lon = 80.2707 }
}
if (-not $cities.ContainsKey($City)) { throw "Unknown city '$City'. Use: $($cities.Keys -join ', ')" }
$acc = $cities[$City]

function Invoke-Api {
    param($Method, $Path, $Body, $Token)
    $headers = @{}
    if ($Token) { $headers.Authorization = "Bearer $Token" }
    if ($Body) {
        return Invoke-RestMethod -Uri "$base$Path" -Method $Method -Headers $headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 6)
    }
    return Invoke-RestMethod -Uri "$base$Path" -Method $Method -Headers $headers
}

Write-Host "=== Demo ride in $City (rider $($acc.Rider) / driver $($acc.Driver)) ===" -ForegroundColor Cyan

# 1. login rider
Invoke-Api POST '/auth/send-otp' @{ phone = $acc.Rider } | Out-Null
$rider = Invoke-Api POST '/auth/verify-otp' @{ phone = $acc.Rider; otp = '123456' }
$riderToken = $rider.accessToken
Write-Host "1. rider logged in (role=$($rider.user.role))"

# 2. saved locations / profile are seeded - show them
$saved = Invoke-Api GET '/users/saved-locations' $null $riderToken
Write-Host "2. saved locations: $($saved.locations.Count) ($(($saved.locations | ForEach-Object { $_.label }) -join ', '))"

# 3. quote (pickup ~1km from city center, dropoff ~2km away) with per-run
#    jitter so repeated demos don't trip the repeated-location fraud guard
$j = (Get-Random -Minimum 0 -Maximum 50) / 100000
$pickupLat = [math]::Round($acc.Lat + 0.012 + $j, 5); $pickupLon = [math]::Round($acc.Lon + 0.009 + $j, 5)
$dropLat = [math]::Round($acc.Lat - 0.018 - $j, 5);  $dropLon = [math]::Round($acc.Lon + 0.021 - $j, 5)
$quote = Invoke-Api GET "/rides/quote?pickupLat=$pickupLat&pickupLon=$pickupLon&dropoffLat=$dropLat&dropoffLon=$dropLon&city=$City" $null $riderToken
$option = $quote.options | Where-Object { $_.rideType -eq $RideType }
if (-not $option) { throw "Ride type '$RideType' not in quote. Available: $(($quote.options | ForEach-Object { $_.rideType }) -join ', ')" }
Write-Host "3. quote $RideType = INR $($option.fare) (eta $($option.etaMinutes) min, surge $($option.surgeMultiplier))"

# 4. request ride
$req = Invoke-Api POST '/rides/request' @{ pickupLat = $pickupLat; pickupLon = $pickupLon; dropoffLat = $dropLat; dropoffLon = $dropLon; rideType = $RideType; city = $City } $riderToken
$rideId = $req.rideId
Write-Host "4. ride requested: $rideId (payable INR $($req.payableFare), status $($req.status))"

# 5. driver accepts the offer immediately (ride stays REQUESTED until accept).
#    Matching hedges offers to the top-3 scored drivers, so try each city driver.
$accept = $null
$driverToken = $null
$baseNum = [long](($acc.Driver -replace '\D', '') -replace '^91', '')
for ($d = 0; $d -le 5; $d += 1) {
    $phone = '+91' + (($baseNum + $d).ToString('0000000000'))
    try {
        Invoke-Api POST '/auth/send-otp' @{ phone = $phone } | Out-Null
        $driver = Invoke-Api POST '/auth/verify-otp' @{ phone = $phone; otp = '123456' }
        $driverToken = $driver.accessToken
        $accept = Invoke-Api POST '/drivers/accept-ride' @{ rideId = $rideId } $driver.accessToken
        Write-Host "5. driver $phone accepted: $($accept | ConvertTo-Json -Compress)"
        break
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 400 -and $_.ErrorDetails.Message -like '*Offer*') {
            continue  # not offered this ride
        }
        throw
    }
}
if (-not $accept) { throw "No driver accepted within 30s (offers expired)" }

# 6. poll until ACCEPTED (or cancelled)
$status = 'REQUESTED'
$driverId = $null
for ($i = 0; $i -lt 10; $i += 1) {
    Start-Sleep -Seconds 3
    $active = Invoke-Api GET '/rides/active' $null $riderToken
    if ($active.rides.Count -gt 0) {
        $status = $active.rides[0].status
        $driverId = $active.rides[0].driverId
        if ($status -ne 'REQUESTED') { break }
    }
}
Write-Host "6. FINAL: ride $rideId -> $status, driver $driverId" -ForegroundColor Green

if ($status -eq 'ACCEPTED') {
    # 7. drive the ride to completion: arrived -> start -> complete
    Invoke-Api POST "/drivers/rides/$rideId/arrived"  $null $driverToken | Out-Null
    Invoke-Api POST "/drivers/rides/$rideId/start"    $null $driverToken | Out-Null
    $done = Invoke-Api POST "/drivers/rides/$rideId/complete" $null $driverToken
    Write-Host "7. completed: $($done | ConvertTo-Json -Compress)"

    # 8. driver wallet + rider sees the ride in history
    $me = Invoke-Api GET '/drivers/me' $null $driverToken
    Write-Host "8. driver profile: $($me | ConvertTo-Json -Compress)"
}
