#!/usr/bin/env python3
"""
Flight Tracker — proxy server.
Serves static files + proxies /api/flights → OpenSky Network API.
"""

import json, math, time, urllib.request, urllib.parse, urllib.error, os
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT      = int(os.environ.get('PORT', 8080))
OPENSKY   = 'https://opensky-network.org/api/states/all'
CACHE_TTL = 8

_cache: dict = {}

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; FlightTracker/1.0)',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
}


def fetch_opensky(lat: float, lon: float, radius_km: float) -> bytes:
    delta_lat = radius_km / 111.32
    delta_lon = radius_km / (111.32 * math.cos(math.radians(lat)))
    lamin, lamax = lat - delta_lat, lat + delta_lat
    lomin, lomax = lon - delta_lon, lon + delta_lon

    key = f'{lamin:.2f},{lomin:.2f},{lamax:.2f},{lomax:.2f}'
    now = time.monotonic()

    if key in _cache:
        data, ts = _cache[key]
        if now - ts < CACHE_TTL:
            return data

    url = (f'{OPENSKY}?lamin={lamin:.6f}&lomin={lomin:.6f}'
           f'&lamax={lamax:.6f}&lomax={lomax:.6f}')

    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = resp.read()

    _cache[key] = (data, now)
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

        # Try up to 2 times (handles transient OpenSky blips)
        last_err = 'Unknown error'
        for attempt in range(2):
            try:
                data = fetch_opensky(lat, lon, radius_km)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
                return
            except urllib.error.HTTPError as e:
                body = e.read().decode(errors='ignore')[:200]
                last_err = f'OpenSky returned HTTP {e.code}: {body}'
                print(f'[OpenSky] HTTP {e.code} on attempt {attempt+1}: {body}')
                if e.code == 429:
                    time.sleep(2)   # back off briefly on rate limit
            except Exception as e:
                last_err = str(e)
                print(f'[OpenSky] Error on attempt {attempt+1}: {e}')
                time.sleep(1)

        self._json(502, {'error': last_err})

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f'[{time.strftime("%H:%M:%S")}] {fmt % args}')


if __name__ == '__main__':
    server = HTTPServer(('', PORT), Handler)
    print(f'✈  Flight Tracker → http://localhost:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
