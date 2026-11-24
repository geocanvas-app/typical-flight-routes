"""Shared constants and helpers of the extractors: the listed jet types and passenger operators, the airport index check,
great-circle distance, and the ground-to-ground leg finder of the first gate. Standard library only."""
import hashlib
import math
import re
import sys

# SHA-256 of the airport index the extractors accept (see README, "Inputs").
AIRPORT_SHA = "973f43a39113ef151d175b5222ebd4ecc1816e38c601f6053ea520bb41133144"
JET_TYPES = set("""
A318 A319 A320 A321 A20N A21N A332 A333 A339 A359 A35K A388 B712 B733 B734 B735 B736 B737 B738
B739 B37M B38M B39M B744 B748 B752 B753 B762 B763 B764 B772 B773 B77L B77W B788 B789 B78X BCS1
BCS3 CRJ7 CRJ9 CRJX E170 E175 E190 E195 E290 E295 E75L E75S
""".split())
OPERATORS = set("""
AAL ACA AEE AEU AFR AIC AMX ANA ANZ ASA AUA AVA AWI AZA BAW BEL BER BWA CCA CES CFG CFE CMP CPA
CSA CSN DAL DLH EDV EIN ENY ETD ETH EWG EXS EZE EZS EZY FFT FIN FJI FLY GLO HAL HVN IBE IBS ICE
JAL JAZ JBU JST KAL KLM LAN LOT LUF MAS NAX NKS NZM PAL PGA PIA QFA QTR QXE RAM RJA RPA RYR SAS
SIA SKW SLK SNC SVA SWA SWR SYR TAP THA THY TOM TSC UAE UAL UCA VIR VOI VLG VOZ WEN WJA WZZ
""".split())

# The first gate keeps legs from 60 km up to but not including 20,000 km.
GATE_MIN_KM, GATE_MAX_KM = 60, 20000
MAX_GAP_S = 10 * 60


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check_airport_index(data, expected=None):
    """Refuses an airport index whose SHA-256 is not the pinned one. `expected` is a hex digest, or "any" to accept another
    index (with a warning: the results then differ from the released ones). None means the pinned AIRPORT_SHA."""
    expected = expected or AIRPORT_SHA
    if expected == "any":
        print(f"WARNING: accepting an airport index with SHA-256 {digest(data)}, not the pinned {AIRPORT_SHA}. "
              "Results will not match the released data.", file=sys.stderr)
    elif digest(data) != expected:
        raise ValueError("Use the airport index listed in the README (SHA-256 mismatch), or pass --airports-sha256 any")


def distance_km(a, b):
    """Great-circle (haversine, 6371 km) distance of two [lon, lat] points."""
    lat1, lat2 = map(math.radians, (a[1], b[1]))
    hav = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(a[0]-b[0])/2)**2
    return 12742 * math.asin(math.sqrt(min(1, hav)))


def nearest_airport(row, airports):
    """The airport within 5 km of a trace row's position, or None. Airport rows are [iata, icao, name, city, country, lon, lat, ...]."""
    point = [row[2], row[1]]
    nearby = (airport for airport in airports if abs(point[1] - airport[6]) < 0.05)
    best = min(((distance_km(point, a[5:7]), a) for a in nearby), default=(math.inf, None), key=lambda pair: pair[0])
    return best[1] if best[0] <= 5 else None


def legs(plane, airports):
    """Ground report to ground report legs of one decoded trace that pass the first gate's filters."""
    rows = plane["trace"]
    last_ground = None
    for end, row in enumerate(rows):
        if row[3] != "ground":
            continue
        begin, last_ground = last_ground, end
        if begin is None or end - begin < 3 or row[0] - rows[begin][0] < 10*60:
            continue
        air = rows[begin+1:end]
        if air[0][0] - rows[begin][0] > 60 or row[0] - air[-1][0] > 60:
            continue
        measured = [r for r in air if r[9] == "adsb_icao" and isinstance(r[3], (int, float))]
        if len(measured) < 3 or measured[0][0] - rows[begin][0] > 60 or row[0] - measured[-1][0] > 60:
            continue
        if any(not 0 < b[0] - a[0] <= MAX_GAP_S for a, b in zip(measured, measured[1:])):
            continue
        callsigns = {r[8]["flight"].strip() for r in measured if isinstance(r[8], dict) and r[8].get("flight")}
        if len(callsigns) != 1:
            continue
        callsign = callsigns.pop()
        if not re.fullmatch(r"[A-Z]{3}[0-9][A-Z0-9]{0,4}", callsign) or callsign[:3] not in OPERATORS:
            continue
        origin = nearest_airport(rows[begin], airports)
        destination = nearest_airport(row, airports)
        if not origin or not destination:
            continue
        km = distance_km(origin[5:7], destination[5:7])
        if not GATE_MIN_KM <= km < GATE_MAX_KM:
            continue
        yield {"icao": plane["icao"], "type": plane["t"], "callsign": callsign,
               "route": f"{origin[0]}-{destination[0]}", "origin": origin[5:7], "destination": destination[5:7],
               "distanceKm": round(km, 3), "firstAirMs": round((plane["timestamp"] + measured[0][0])*1000),
               "lastAirMs": round((plane["timestamp"] + measured[-1][0])*1000), "airSamples": len(measured)}
