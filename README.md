# PubTrans MPLS

Autonomous SDEV (self-driving electric vehicle) shuttle simulation on the real street network of
downtown Minneapolis and the University of Minnesota East and West Bank campuses.

Adapted from [pubtrans_15_minute_city](https://github.com/jsherman999/pubtrans_15_minute_city)
(source commit `60774088fd727f49125c9bb2e979839fe8b3be2c`). The imported app still runs unchanged
from `index.html` while the port is in progress; its original documentation is in
[`docs/SOURCE_README.md`](docs/SOURCE_README.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).

See **[PLAN.md](PLAN.md)** for the phased build plan and current progress.

## Run locally

```
python3 -m http.server 8000
```

Open http://localhost:8000. Source-app regression suite (slow, several minutes):

```
node tests/simulation.cjs
```
