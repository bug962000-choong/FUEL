'use strict';

globalThis.FuelData = (() => {
  const fuels = ['고급휘발유', '휘발유', '경유', '실내등유'];
  const fields = {
    stations: ['주유소명', '시도명', '시군구명', '소재지도로명주소', '소재지지번주소', '위도', '경도'],
    prices: ['번호', '지역', '상호', '주소', '기간', ...fuels],
  };
  const number = new Intl.NumberFormat('ko-KR');
  const compact = (value = '') => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  function parseCsv(input) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      text = new TextDecoder('euc-kr', { fatal: true }).decode(input);
    }
    const records = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char !== '"') field += char;
        else if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else if (char === '"' && !field) quoted = true;
      else if (char === ',') { row.push(field); field = ''; }
      else if (char === '\n' || char === '\r') {
        row.push(field);
        records.push(row);
        row = [];
        field = '';
        if (char === '\r' && text[i + 1] === '\n') i++;
      } else field += char;
    }
    if (quoted) throw new Error('닫히지 않은 큰따옴표가 있습니다.');
    if (row.length || field) records.push([...row, field]);
    return records.filter(values => values.some(value => value.trim()));
  }

  function dateValid(value) {
    if (!/^\d{8}$/.test(value)) return false;
    const formatted = dateLabel(value);
    const date = new Date(`${formatted}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === formatted;
  }

  function readCsv(input, kind) {
    const [header, ...records] = parseCsv(input);
    if (!header) throw new Error('CSV가 비어 있습니다.');
    const names = header.map(value => value.trim());
    const missing = fields[kind].filter(name => !names.includes(name));
    if (missing.length) throw new Error(`필수 열 누락 (${missing.join(', ')})`);
    if (new Set(names).size !== names.length) throw new Error('이름이 중복된 열이 있습니다.');
    const rows = [], errors = new Map();
    for (const values of records) {
      if (kind === 'prices' && values.length === 1 && /^기준\s*:/.test(values[0].trim())) continue;
      let reason;
      if (values.length !== header.length) reason = '열 개수 불일치';
      else {
        const value = Object.fromEntries(names.map((name, i) => [name, values[i].trim()]));
        if (kind === 'prices' && !dateValid(value.기간)) reason = '유효하지 않은 기간';
        else rows.push({ values, value });
      }
      if (reason) errors.set(reason, (errors.get(reason) || 0) + 1);
    }
    return { header, rows, errors };
  }

  function csvText(header, rows) {
    const escape = value => /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    return '\uFEFF' + [header, ...rows.map(row => row.values)]
      .map(values => values.map(escape).join(',')).join('\r\n') + '\r\n';
  }

  const provinceAliases = {
    '서울특별시': ['서울'], '부산광역시': ['부산'], '대구광역시': ['대구'],
    '인천광역시': ['인천'], '대전광역시': ['대전'], '울산광역시': ['울산'],
    '세종특별자치시': ['세종', '세종시'], '경기도': ['경기'],
    '강원특별자치도': ['강원도', '강원'], '충청북도': ['충북'], '충청남도': ['충남'],
    '전북특별자치도': ['전라북도', '전북'], '전남광주통합특별시': ['전라남도', '전남', '광주광역시', '광주', '전남광주'],
    '경상북도': ['경북'], '경상남도': ['경남'], '제주특별자치도': ['제주도', '제주'],
  };

  function extent(polygons) {
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of polygons) for (const [x, y] of polygon[0]) {
      if (x < bounds[0]) bounds[0] = x;
      if (y < bounds[1]) bounds[1] = y;
      if (x > bounds[2]) bounds[2] = x;
      if (y > bounds[3]) bounds[3] = y;
    }
    return bounds;
  }

  function makeRegions(geojson) {
    const all = { id: 'all', name: '전국', label: '전국', children: [], features: [] };
    const byId = new Map([[all.id, all]]);
    const get = (id, name, parent) => {
      if (!byId.has(id)) {
        const label = parent === all || parent.name === name ? (parent === all ? name : parent.label) : `${parent.label} ${name}`;
        const region = { id, name, label, parent, children: [], features: [] };
        byId.set(id, region);
        parent.children.push(region);
      }
      return byId.get(id);
    };
    for (const { properties: p, geometry } of geojson.features) {
      if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) continue;
      const province = get(`p${p.sido}`, p.sidonm, all);
      const district = get(`d${p.sgg}`, p.sggnm || p.sidonm, province);
      const name = p.adm_nm.trim().split(/\s+/).at(-1);
      const town = get(`t${p.adm_cd2 || p.adm_cd}`, name, district);
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      const feature = { town, polygons, bounds: extent(polygons) };
      for (const region of [all, province, district, town]) region.features.push(feature);
    }
    for (const province of all.children) {
      for (const district of [...province.children]) {
        const city = district.name.match(/^(.+?시)\s*.+구$/)?.[1];
        if (!city) continue;
        const aggregate = get(`m${province.id}:${city}`, city, province);
        district.metro = aggregate;
        for (const town of district.children) aggregate.children.push(town);
        for (const feature of district.features) aggregate.features.push(feature);
      }
    }
    for (const region of byId.values()) region.children.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    const aliases = all.children.flatMap(province => [province.name, ...(provinceAliases[province.name] || [])]
      .map(name => ({ prefix: compact(name), province }))).sort((a, b) => b.prefix.length - a.prefix.length);
    const districtNames = new Map(all.children.map(province => [province, province.children.flatMap(region => {
      const names = [region.name];
      if (region.metro) names.push(region.name.replace(/^(.+?)시\s*(.+구)$/, '$1$2'));
      return names.map(name => ({ key: compact(name), region }));
    }).sort((a, b) => b.key.length - a.key.length)]));
    return { all, byId, aliases, districtNames };
  }

  function locateDistrict(regions, regionText, extraText = '') {
    const key = compact(regionText);
    const provinceMatch = regions.aliases.find(({ prefix }) => key.startsWith(prefix));
    if (!provinceMatch) return {};
    const { province, prefix } = provinceMatch;
    const suffix = key.slice(prefix.length);
    const districts = regions.districtNames.get(province);
    let district = districts.find(d => suffix.startsWith(d.key));
    if ((!district || district.region.id.startsWith('m')) && extraText) {
      const addressKey = compact(extraText);
      const alias = regions.aliases.find(a => a.province === province && addressKey.startsWith(a.prefix));
      const tail = alias ? addressKey.slice(alias.prefix.length) : addressKey;
      const fromAddress = districts.find(d => tail.startsWith(d.key));
      if (fromAddress && (!district || fromAddress.region.metro === district.region)) district = fromAddress;
    }
    if (!district && province.children.length === 1) return { province, district: province.children[0] };
    const found = district?.region;
    return found?.id.startsWith('m') ? { province, metro: found } : { province, district: found, metro: found?.metro };
  }

  function ringContains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function featureContains({ bounds, polygons }, x, y) {
    return x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3] &&
      polygons.some(([outer, ...holes]) => ringContains(outer, x, y) && !holes.some(ring => ringContains(ring, x, y)));
  }

  function townFromAddress(district, address) {
    if (!district || !address) return undefined;
    const tokens = address.match(/[가-힣\d]+(?:읍|면|동)(?=\s|[(),]|$)/g) || [];
    const candidates = district.children.filter(town => tokens.includes(town.name));
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  function point(value) {
    const lat = Number(value.위도), lon = Number(value.경도);
    return lon >= 123 && lon <= 133 && lat >= 32 && lat <= 40 ? [lon, lat] : undefined;
  }

  function roadKey(address) {
    const road = address.normalize('NFKC').replace(/\s*([로길])\s*(\d)/g, '$1 $2')
      .match(/([가-힣0-9·.]+[로길])\s+(\d+(?:\s*-\s*\d+)?)(?![\d-])/);
    return road ? `${compact(road[1])}:${road[2].replace(/\s/g, '')}` : '';
  }

  function addressKeys(...addresses) {
    return [...new Set(addresses.filter(Boolean).flatMap(address => {
      const full = compact(address.replace(/\([^)]*\)/g, ''));
      return [full, roadKey(address)].filter(key => key && /\d/.test(key));
    }))];
  }

  const stationName = name => compact(name.replace(/주식회사|\(\s*주\s*\)|㈜/g, ''));

  // Each verified pair is scoped to a price ID and district. See PRD §8 for the source comparison.
  const verifiedStationAliases = new Map([
    ['A0011342', { district: 'd51150',
      stationName: '(주)교동택지주유소', stationRoad: '하슬라로 233',
      priceName: '지에스칼텍스㈜ 강릉교동택지주유소', priceRoad: '교동하슬라로 233' }],
    ['A0011368', { district: 'd51150',
      stationName: '㈜에스엠넷직영북강릉주유소', stationRoad: '남평길 1',
      priceName: '코켐소재㈜직영 북강릉주유소', priceRoad: '남평길 3' }],
    ['A0011448', { district: 'd51150',
      stationName: '연곡주유소', stationRoad: '진고개로 2726-6',
      priceName: '연곡주유소', priceRoad: '진고개로 2720' }],
    ['A0011581', { district: 'd51150',
      stationName: '(주)서원구정(속초방향)주유소', stationRoad: '동해고속도로 346-1',
      priceName: '구정(속초)주유소', priceRoad: '동해고속도로 346' }],
  ]);

  function verifiedAliasMatch(groupId, items, stationsByAddress) {
    const alias = verifiedStationAliases.get(groupId);
    if (!alias) return undefined;
    const priceName = stationName(alias.priceName), priceRoad = roadKey(alias.priceRoad);
    if (!items.every(({ district, value }) => district?.id === alias.district &&
      stationName(value.상호) === priceName && roadKey(value.주소) === priceRoad)) return undefined;
    const address = `${alias.district}:${roadKey(alias.stationRoad)}`;
    const name = stationName(alias.stationName);
    const matches = [...(stationsByAddress.get(address) || [])]
      .filter(({ value }) => stationName(value.주유소명) === name);
    return matches.length === 1 ? matches[0] : undefined;
  }

  const recordsBy = (map, key, record) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(record);
  };

  function combine(regions, stationFile, priceFile) {
    const stationsByAddress = new Map(), priceByAddress = new Map();
    const stations = stationFile.rows.map((row, id) => {
      const { value: v } = row;
      const address = v.소재지도로명주소 || v.소재지지번주소;
      const region = locateDistrict(regions, `${v.시도명} ${v.시군구명}`, address);
      const coordinates = point(v);
      const scope = region.district || region.metro;
      const town = coordinates && scope?.features.find(f => featureContains(f, ...coordinates))?.town ||
        townFromAddress(scope, v.소재지지번주소 || v.소재지도로명주소);
      if (town && !region.district) region.district = town.parent;
      const station = { ...row, ...region, town, coordinates, id, history: new Map() };
      for (const area of [region.district, region.metro].filter(Boolean)) {
        for (const key of addressKeys(v.소재지도로명주소, v.소재지지번주소)) recordsBy(stationsByAddress, `${area.id}:${key}`, station);
      }
      return station;
    });
    const groups = new Map();
    const prices = priceFile.rows.map(row => {
      const { value: v } = row;
      const region = locateDistrict(regions, v.지역, v.주소);
      const town = townFromAddress(region.district || region.metro, v.주소);
      if (town && !region.district) region.district = town.parent;
      const price = { ...row, ...region, town };
      const groupId = v.번호 || `${v.지역}:${v.상호}:${v.주소}`;
      if (!groups.has(groupId)) groups.set(groupId, { items: [], keys: new Set() });
      const group = groups.get(groupId);
      group.items.push(price);
      for (const area of [region.district, region.metro].filter(Boolean)) {
        for (const key of addressKeys(v.주소)) {
          const lookup = `${area.id}:${key}`;
          group.keys.add(lookup);
          recordsBy(priceByAddress, lookup, group);
        }
      }
      return price;
    });
    const proposed = new Map(), aliasProposals = new Map();
    for (const [groupId, group] of groups) {
      const compatible = (price, station) => price.province === station.province && (price.district && station.district
        ? price.district === station.district : price.metro && price.metro === station.metro);
      const candidates = new Set([...group.keys].flatMap(key => [...(stationsByAddress.get(key) || [])])
        .filter(station => group.items.every(price => compatible(price, station))));
      const names = new Set(group.items.map(row => stationName(row.value.상호)));
      const byName = [...candidates].filter(station => names.has(stationName(station.value.주유소명)));
      const uniqueAddress = candidates.size === 1 && [...group.keys].some(key =>
        stationsByAddress.get(key)?.size === 1 && priceByAddress.get(key).size === 1);
      const match = byName.length === 1 ? byName[0] : !byName.length && uniqueAddress ? [...candidates][0] : undefined;
      if (match) recordsBy(proposed, match, group);
      if (!candidates.size) {
        const alias = verifiedAliasMatch(groupId, group.items, stationsByAddress);
        if (alias) recordsBy(aliasProposals, alias, group);
      }
    }
    for (const [station, candidates] of aliasProposals) {
      if (!proposed.has(station)) proposed.set(station, candidates);
    }
    for (const [station, candidates] of proposed) {
      if (candidates.size !== 1) continue;
      for (const price of [...candidates][0].items) {
        price.station = station;
        price.district ||= station.district;
        price.town = station.town || price.town;
        const sameDate = station.history.get(price.value.기간);
        if (!sameDate) station.history.set(price.value.기간, price);
        else if (fuels.some(fuel => price.value[fuel] !== sameDate.value[fuel]) || price.value.셀프여부 !== sameDate.value.셀프여부) {
          sameDate.conflict = true;
        }
      }
    }
    return { stations, prices };
  }

  function inRegion(row, region) {
    return region.id === 'all' || row.province === region || row.metro === region || row.district === region || row.town === region;
  }

  function dateLabel(value) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }

  return { readCsv, csvText, makeRegions, combine, inRegion, featureContains, dateLabel, fuels, number };
})();
