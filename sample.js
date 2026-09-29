/* Sample data so the app works before Garage61 is connected.
   Replaced by the real /api/combos response once the Worker is live. */
(function () {
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const f = (name, base, step, unit, dec) => ({ name, base, step, unit: unit || '', dec: dec || 0 });
  const GT3 = [
    ['Tires', [f('Cold pressure LF', 152, 2, ' kPa'), f('Cold pressure RF', 152, 2, ' kPa'), f('Cold pressure LR', 148, 2, ' kPa'), f('Cold pressure RR', 148, 2, ' kPa')]],
    ['Aero', [f('Front ride height', 52, 1, ' mm'), f('Rear ride height', 68, 1, ' mm'), f('Rear wing angle', 8, 1, '°')]],
    ['Suspension', [f('Front anti-roll bar', 3, 1), f('Rear anti-roll bar', 4, 1), f('Front camber', -3.4, 0.1, '°', 1), f('Rear camber', -2.8, 0.1, '°', 1), f('Front toe', -0.4, 0.05, ' mm', 2)]],
    ['Dampers', [f('Front bump', 6, 1), f('Front rebound', 9, 1), f('Rear bump', 6, 1), f('Rear rebound', 10, 1)]],
    ['Brakes & diff', [f('Brake bias', 54.5, 0.5, '%', 1), f('Traction control', 4, 1), f('ABS', 3, 1), f('Diff preload', 80, 10, ' Nm')]]
  ];
  const MX5 = [
    ['Tires', [f('Cold pressure LF', 28, 0.5, ' psi', 1), f('Cold pressure RF', 28, 0.5, ' psi', 1), f('Cold pressure LR', 26, 0.5, ' psi', 1), f('Cold pressure RR', 26, 0.5, ' psi', 1)]],
    ['Suspension', [f('Front anti-roll bar', 5, 1), f('Rear anti-roll bar', 3, 1), f('Front camber', -2.6, 0.1, '°', 1), f('Rear camber', -2.2, 0.1, '°', 1), f('Rear toe', 0.1, 0.05, '°', 2)]],
    ['Dampers', [f('Front rebound', 7, 1), f('Rear rebound', 6, 1)]],
    ['Brakes', [f('Brake bias', 55.0, 0.5, '%', 1)]]
  ];
  const F3 = [
    ['Tires', [f('Cold pressure front', 130, 2, ' kPa'), f('Cold pressure rear', 124, 2, ' kPa')]],
    ['Aero', [f('Front wing angle', 12, 1, '°'), f('Rear wing angle', 14, 1, '°'), f('Rear ride height', 42, 1, ' mm')]],
    ['Suspension', [f('Front anti-roll bar', 4, 1), f('Rear anti-roll bar', 3, 1), f('Front camber', -2.9, 0.1, '°', 1)]],
    ['Brakes & diff', [f('Brake bias', 56.5, 0.5, '%', 1), f('Diff preload', 60, 10, ' Nm')]]
  ];

  const SPECS = [
    { car: 'Porsche 911 GT3 R (992)', track: 'WeatherTech Raceway Laguna Seca', base: 82900, tpl: GT3 },
    { car: 'Mazda MX-5 Cup', track: 'Lime Rock Park', base: 60800, tpl: MX5 },
    { car: 'BMW M4 GT3 EVO', track: 'Road America', base: 123500, tpl: GT3 },
    { car: 'Porsche 911 GT3 Cup (992)', track: 'Watkins Glen International', base: 106200, tpl: GT3 },
    { car: 'Ferrari 296 GT3', track: 'Daytona International Speedway', base: 104800, tpl: GT3 },
    { car: 'Dallara F3', track: 'Circuit de Spa-Francorchamps', base: 139000, tpl: F3 }
  ];

  const DRIVERS = [
    { id: 'aaron', name: 'Aaron', initials: 'AS' },
    { id: 'mia', name: 'Mia', initials: 'MR' },
    { id: 'dev', name: 'Dev', initials: 'DK' }
  ];

  function build(spec, idx) {
    const r = rng(1000 + idx * 77);
    const gauss = () => (r() + r() + r() - 1.5) / 1.5;
    const id = 'c' + idx;
    // Flatten template into a current-values map, one snapshot per session.
    const fields = [];
    spec.tpl.forEach(([sec, list]) => list.forEach(fd => fields.push({ sec, fd })));
    let cur = fields.map(x => x.fd.base);
    const setups = {};
    const laps = [];
    const sessions = 9;
    const anchor = Date.UTC(2026, 8, 27, 18, 0);
    let n = 0;
    for (let s = 0; s < sessions; s++) {
      if (s > 0) {
        const tweaks = 1 + Math.floor(r() * 3);
        for (let k = 0; k < tweaks; k++) {
          const i = Math.floor(r() * fields.length);
          const fd = fields[i].fd;
          cur[i] = +(cur[i] + (r() < 0.5 ? -1 : 1) * fd.step).toFixed(3);
        }
      }
      const setupId = id + 's' + s;
      const secs = {};
      fields.forEach((x, i) => { (secs[x.sec] = secs[x.sec] || []).push({ name: x.fd.name, value: cur[i], unit: x.fd.unit, dec: x.fd.dec }); });
      setups[setupId] = { id: setupId, name: 'Setup v' + (s + 1), sections: Object.keys(secs).map(k => ({ title: k, fields: secs[k] })) };
      const date = anchor - (sessions - 1 - s) * 6.5 * 86400000;
      const each = 4 + Math.floor(r() * 5);
      DRIVERS.forEach((d, di) => {
        if (di === 1 && ![2, 5, 7].includes(s)) return;
        if (di === 2 && ![4, 6].includes(s)) return;
        const count = di === 0 ? each : 3 + Math.floor(r() * 3);
        for (let k = 0; k < count; k++) {
          const learn = 2600 * Math.exp(-n / 24);
          let ms = spec.base + learn + Math.abs(gauss()) * 520 + di * (500 + r() * 400) + (8 - s) * 18;
          if (r() < 0.09) ms += 2500 + r() * 3500;
          laps.push({
            id: id + 'l' + n, driver: d.id, ms: Math.round(ms),
            at: Math.round(date + k * 130000 + di * 3600000), setupId,
            airC: 18 + Math.round(r() * 12), trackC: 26 + Math.round(r() * 16)
          });
          n++;
        }
      });
    }
    laps.sort((a, b) => a.at - b.at);
    return { id, car: spec.car, track: spec.track, laps, setups };
  }

  window.SAMPLE = { drivers: DRIVERS, me: 'aaron', combos: SPECS.map(build), isSample: true };
})();
