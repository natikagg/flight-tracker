#!/usr/bin/env python3
"""
Flight Tracker — proxy server.
- Serves static files
- Proxies /api/flights → OpenSky Network API
- Server-side cache: returns cached data if < 8 seconds old
  so the client can poll every 5s without burning rate limits.

Usage:  python3 server.py
        Open http://localhost:8080
"""

import json, math, time, urllib.request, urllib.parse, urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT       = int(__import__('os').environ.get('PORT', 8080))
OPENSKY    = 'https://opensky-network.org/api/states/all'
CACHE_TTL  = 8   # seconds — OpenSky updates every ~5-10s anyway

# Cache: key = rounded bbox string → (bytes, timestamp)
_cache: dict = {}


def fetch_opensky(lat: float, lon: float, radius_km: float) -> bytes:
    delta_lat = radius_km / 111.32
    delta_lon = radius_km / (111.32 * math.cos(math.radians(lat)))
    lamin, lamax = lat - delta_lat, lat + delta_lat
    lomin, lomax = lon - delta_lon, lon + delta_lon

    # Round to 2 decimal places for cache key (≈1km grid)
    key = f'{lamin:.2f},{lomin:.2f},{lamax:.2f},{lomax:.2f}'
    now = time.monotonic()

    if key in _cache:
        data, ts = _cache[key]
        if now - ts < CACHE_TTL:
            return data          # serve cached

    url = (f'{OPENSKY}?lamin={lamin:.6f}&lomin={lomin:.6f}'
           f'&lamax={lamax:.6f}&lomax={lomax:.6f}')
    req = urllib.request.Request(url, headers={'User-Agent': 'FlightTracker/1.0'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = resp.read()

    _cache[key] = (data, now)
    # Evict old entries to avoid unbounded growth
    for k in [k for k, (_, t) in _cache.items() if now - t > 120]:
        del _cache[k]

    return data


class Handler(SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path.startswith('/api/flights'):
            self._handle_flights()
        else:
            super().do_GET()

    def _handle_flights(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            lat       = float(params['lat'][0])
            lon       = float(params['lon'][0])
            radius_km = float(params.get('radius_km', ['50'])[0])
        except (KeyError, ValueError, IndexError):
            self._json(400, {'error': 'Missing or invalid lat/lon'})
            return

        try:
            data = fetch_opensky(lat, lon, radius_km)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as e:
            self._json(502, {'error': f'OpenSky HTTP {e.code}'})
        except Exception as e:
            self._json(502, {'error': str(e)})

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if args and '/api/' in str(args[0]):
            print(f'[{time.strftime("%H:%M:%S")}] {args[0]}')


if __name__ == '__main__':
    server = HTTPServer(('', PORT), Handler)
    print(f'✈  Flight Tracker  →  http://localhost:{PORT}')
    print(f'   OpenSky cache TTL: {CACHE_TTL}s  |  Ctrl+C to stop\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
