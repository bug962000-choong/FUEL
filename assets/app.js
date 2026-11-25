'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const D = FuelData;
  const page = document.body.dataset.page;
  const selects = ['province', 'district', 'town'].map($);
  const files = {};
  const pending = {};
  const fileNames = { stations: '주유소', prices: '주유가격' };
  let regions, selection, map, data, activeStation;
  let filtered = { stations: [], prices: [] };

  function icon(name) {
    const image = document.createElement('img');
    image.src = `assets/icons/${name}.svg`;
    image.alt = '';
    return image;
  }

  function setOptions(select, list, blankLabel, selected = '') {
    const duplicateNames = new Set(list.filter((item, i) => list.findIndex(region => region.name === item.name) !== i).map(item => item.name));
    select.replaceChildren(new Option(blankLabel, ''), ...list.map(item => new Option(
      duplicateNames.has(item.name) ? `${item.parent.name} ${item.name}` : item.name, item.id,
    )));
    select.value = selected;
  }

  function applyRegion(region) {
    const town = region.id.startsWith('t') ? region : undefined;
    const district = town?.parent || (/^[dm]/.test(region.id) ? region : undefined);
    const province = district?.parent || (region.id.startsWith('p') ? region : undefined);
    selects[0].value = province?.id || '';
    setOptions(selects[1], province?.children || [], '전체', district?.id);
    setOptions(selects[2], district?.children || [], '전체', town?.id);
    selects[1].disabled = !province;
    selects[2].disabled = !district;
    if (selection !== region && page === 'map') $('station-search').value = '';
    selection = region;
    refresh();
  }

  function loadFiles() {
    data = regions && files.stations && files.prices ? D.combine(regions, files.stations, files.prices) : undefined;
    if (!regions) return;
    $('status').textContent = data ? '두 파일을 불러왔습니다. 지역을 선택하세요.' : '주유소 CSV와 주유가격 CSV를 불러오세요.';
    refresh();
  }

  for (const kind of Object.keys(fileNames)) $(kind).addEventListener('change', async event => {
    const file = event.target.files?.[0];
    const note = $(`${kind}-info`);
    const token = Symbol();
    pending[kind] = token;
    delete files[kind];
    note.classList.remove('error');
    note.textContent = file ? `${file.name} 읽는 중…` : `${fileNames[kind]} CSV 선택`;
    loadFiles();
    if (!file) return;
    try {
      const parsed = D.readCsv(await file.arrayBuffer(), kind);
      if (pending[kind] !== token) return;
      files[kind] = parsed;
      const summary = [`${file.name} · ${D.number.format(parsed.rows.length)}행`];
      if (kind === 'prices' && parsed.rows.length) {
        const dates = [...new Set(parsed.rows.map(row => row.value.기간))].sort();
        summary.push(`${D.dateLabel(dates[0])} ~ ${D.dateLabel(dates.at(-1))}`);
      }
      for (const [reason, count] of parsed.errors) summary.push(`${reason} ${D.number.format(count)}행 제외`);
      note.textContent = summary.join(' · ');
      loadFiles();
    } catch (error) {
      if (pending[kind] !== token) return;
      delete files[kind];
      note.classList.add('error');
      note.textContent = `${file.name} · ${error.message || 'CSV를 읽을 수 없습니다.'}`;
      loadFiles();
    }
  });

  function refresh() {
    if (!selection) return;
    $('region-name').textContent = selection.label;
    filtered = data ? {
      stations: data.stations.filter(row => D.inRegion(row, selection)),
      prices: data.prices.filter(row => D.inRegion(row, selection)),
    } : { stations: [], prices: [] };

    if (data) {
      const scope = { t: 'town', d: 'district', m: 'city' }[selection.id[0]] || 'province';
      const parent = selection.metro || selection.parent;
      const unknown = [...data.stations, ...data.prices].filter(row =>
        (scope === 'city' ? !row.metro && !row.district : !row[scope]) && (!parent || D.inRegion(row, parent))).length;
      const linked = filtered.stations.filter(station => station.history.size).length;
      const counts = `주유소 ${D.number.format(filtered.stations.length)}곳 · 가격 기록 ${D.number.format(filtered.prices.length)}건`;
      const linkage = `가격 연결 ${D.number.format(linked)}곳 · 미연결 ${D.number.format(filtered.stations.length - linked)}곳`;
      const coordinates = filtered.stations.filter(station => !station.coordinates).length;
      $('selection-note').textContent = `${counts} · ${linkage} · 지역 미확정 ${D.number.format(unknown)}행` +
        (page === 'map' && coordinates ? ` · 좌표 없음 또는 오류 ${D.number.format(coordinates)}곳` : '');
    } else {
      $('selection-note').textContent = page === 'map' ? '파일을 불러오면 지도와 목록에 주유소가 표시됩니다.' : '파일을 불러오면 추출 건수가 표시됩니다.';
    }

    if (page === 'extract') {
      $('station-count').textContent = data ? D.number.format(filtered.stations.length) : '—';
      $('price-count').textContent = data ? D.number.format(filtered.prices.length) : '—';
      $('save-stations').disabled = !data;
      $('save-prices').disabled = !data;
    } else if (map) {
      activeStation = undefined;
      map.setRegion(selection, filtered.stations);
      $('station-search').disabled = !filtered.stations.length;
      showDetails();
      showList();
    }
  }

  function save(kind) {
    if (!data) return;
    const csv = new Blob([D.csvText(files[kind].header, filtered[kind])], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(csv);
    const label = selection.parent?.children.some(region => region !== selection && region.name === selection.name) ? selection.label : selection.name;
    link.download = `${label.replace(/[<>:"/\\|?*]/g, '_')}_${fileNames[kind]}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }

  function showList() {
    const list = $('station-list');
    list.replaceChildren();
    $('station-total').textContent = data ? `${D.number.format(filtered.stations.length)}곳` : '';
    const query = $('station-search').value.trim().toLowerCase();
    const fragment = document.createDocumentFragment();
    for (const station of filtered.stations) {
      const v = station.value;
      const address = v.소재지도로명주소 || v.소재지지번주소 || '';
      if (query && !`${v.주유소명} ${address}`.toLowerCase().includes(query)) continue;
      const item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button';
      button.dataset.station = station.id;
      button.setAttribute('aria-pressed', String(activeStation === station));
      const name = document.createElement('strong'), location = document.createElement('small');
      name.textContent = v.주유소명 || '이름 없음';
      location.textContent = `${address || '주소 없음'}${station.coordinates ? '' : ' · 지도 좌표 없음'}`;
      button.append(name, location);
      button.addEventListener('click', () => chooseStation(station, true));
      item.append(button);
      fragment.append(item);
    }
    if (!fragment.childElementCount) {
      const empty = document.createElement('li');
      empty.textContent = !data ? '두 CSV를 불러오세요.' : query ? '검색 결과가 없습니다.' : '선택 지역에 주유소가 없습니다.';
      fragment.append(empty);
    }
    list.append(fragment);
  }

  function chooseStation(station, clickedList) {
    const previous = activeStation;
    activeStation = station;
    map.select(station, clickedList);
    showDetails(station);
    const list = $('station-list');
    const prevButton = previous && list.querySelector(`[data-station="${previous.id}"]`);
    prevButton?.setAttribute('aria-pressed', 'false');
    let nextButton = list.querySelector(`[data-station="${station.id}"]`);
    if (!nextButton) {
      $('station-search').value = '';
      showList();
      nextButton = list.querySelector(`[data-station="${station.id}"]`);
    }
    nextButton?.setAttribute('aria-pressed', 'true');
    if (!clickedList && nextButton) list.scrollTop += nextButton.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }

  function showDetails(station) {
    const panel = $('details');
    const title = document.createElement('h2');
    title.textContent = station?.value.주유소명 || '주유가격';
    panel.replaceChildren(title);
    const note = message => {
      const p = document.createElement('p');
      p.textContent = message;
      panel.append(p);
    };
    if (!station) { note('주유소를 선택하면 날짜별 판매가격이 표시됩니다.'); return; }
    const v = station.value;
    const metadata = document.createElement('p');
    metadata.className = 'detail-meta';
    const item = (image, content) => {
      const span = document.createElement('span');
      span.append(icon(image), document.createTextNode(content));
      metadata.append(span);
    };
    item('map-pin', v.소재지도로명주소 || v.소재지지번주소 || '주소 정보 없음');
    item('fuel', v.상표구분명 || '상표 정보 없음');
    panel.append(metadata);
    if (!station.coordinates) note('지도에 표시할 좌표가 없습니다.');
    if (!station.history.size) { note('연결된 가격 정보 없음'); return; }

    const dateField = document.createElement('label'), select = document.createElement('select');
    dateField.className = 'date-field';
    const dateTitle = document.createElement('span');
    dateTitle.append(icon('calendar-days'), document.createTextNode('기록일'));
    dateField.append(dateTitle, select);
    const dates = [...station.history.keys()].sort().reverse();
    for (const date of dates) select.add(new Option(D.dateLabel(date), date));
    const self = document.createElement('p'), prices = document.createElement('dl');
    prices.className = 'price-list';
    panel.append(dateField, self, prices);
    const displayDate = () => {
      const record = station.history.get(select.value);
      self.textContent = record.conflict ? '이 날짜의 가격 기록이 서로 다릅니다.' : `셀프 여부 · ${record.value.셀프여부 || '정보 없음'}`;
      prices.replaceChildren();
      for (const fuel of D.fuels) {
        const item = document.createElement('div'), type = document.createElement('dt'), amount = document.createElement('dd');
        type.textContent = fuel;
        const value = Number(record.value[fuel].replaceAll(',', ''));
        amount.textContent = !record.conflict && Number.isFinite(value) && value > 0 ? `${D.number.format(value)}원/L` : '가격 정보 없음';
        item.append(type, amount);
        prices.append(item);
      }
    };
    select.addEventListener('change', displayDate);
    displayDate();
  }

  async function init() {
    const bytes = typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(FuelRegionArchive)
      : Uint8Array.from(atob(FuelRegionArchive), char => char.charCodeAt(0));
    globalThis.FuelRegionArchive = undefined;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    regions = D.makeRegions(await new Response(stream).json());
    setOptions(selects[0], regions.all.children, '전국');
    selects.forEach((select, index) => select.addEventListener('change', () => {
      const result = select.value || selects[index - 1]?.value || 'all';
      applyRegion(regions.byId.get(result));
    }));
    $('region-fields').disabled = false;
    if (page === 'extract') {
      $('save-stations').addEventListener('click', () => save('stations'));
      $('save-prices').addEventListener('click', () => save('prices'));
    } else {
      map = new FuelMap($('map-canvas'), regions.all, station => chooseStation(station, false), applyRegion);
      $('zoom-in').addEventListener('click', () => map.zoom(1.25));
      $('zoom-out').addEventListener('click', () => map.zoom(.8));
      $('recenter').addEventListener('click', () => map.fit());
      $('station-search').addEventListener('input', showList);
    }
    applyRegion(regions.all);
    loadFiles();
  }

  init().catch(error => {
    console.error(error);
    $('status').classList.add('error');
    $('status').textContent = '행정구역 데이터를 읽을 수 없습니다. 앱 폴더의 assets 파일을 확인하고 최신 Edge 또는 Chrome에서 다시 열어 주세요.';
  });
})();
