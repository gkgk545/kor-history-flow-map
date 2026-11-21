# 데이터 출처

## 바탕 지도 — Natural Earth

| 항목 | 내용 |
|---|---|
| 자료 | Natural Earth 1:10m Physical — `ne_10m_land`(육지), `ne_10m_rivers_lake_centerlines`(하천) |
| 버전 | 육지 v5.1.1, 하천 v5.0.0 (압축 파일 안 `*.VERSION.txt`) |
| 라이선스 | 퍼블릭 도메인 (Natural Earth 이용 조건: 허락 없이 자유롭게 사용, 출처 표기는 권장) |
| 받은 날 | 2026-11-21, 한 번만 받음 |
| 받은 곳 | `https://naciscdn.org/naturalearth/10m/physical/ne_10m_land.zip`<br>`https://naciscdn.org/naturalearth/10m/physical/ne_10m_rivers_lake_centerlines.zip` |
| SHA-256 | land `e547d749445eaa0964aba76738090ec88f5e63c4585122170f98c67a7ea922dc`<br>rivers `ded71b01870855ccfe19b51f2ec14c9bb48fae23c0e9f3c11974d426433b5c38` |

- naturalearthdata.com 다운로드 페이지의 링크(`/http//www.naturalearthdata.com/download/10m/...`)는 이날 WordPress 오류(HTTP 500)를 돌려주었다. 그래서 그 링크가 가리키는 Natural Earth 공식 배포 서버(naciscdn.org)에서 같은 파일을 받았다.
- 원본 압축 파일은 저장소에 넣지 않았다. 자른 결과만 `base-land.geojson`, `base-rivers.geojson`으로 넣었다.

### 가공 (`scripts/build-data.mjs --ne <폴더>`)

1. Shapefile(.shp/.dbf)을 의존성 없는 Node 코드로 읽는다.
2. 경도 115~135°, 위도 32~48° 사각형으로 자른다(Sutherland–Hodgman).
3. Douglas–Peucker로 단순화한다. 육지 0.006°, 하천 0.01°.
4. 넓이 약 6㎢ 미만의 아주 작은 섬은 뺀다. 울릉도는 남는다. 독도는 Natural Earth 1:10m에 없어 나라 도형으로 따로 그렸다.
5. 하천은 압록강, 두만강, 한강(남한강 포함), 낙동강, 요하, 송화강(제2송화강 포함)만 남긴다.
6. 결과: 육지 고리 173개(꼭짓점 4,937개).

### 대동강 — 도식선

Natural Earth 1:10m 하천 자료에 대동강이 없다. 그래서 `rivers-schematic.geojson`에 꼭짓점 8개짜리 도식선을 직접 그렸다. 기준점은 낭림산맥 남쪽 발원 부근, 덕천, 순천, 평양, 남포 하구다. 화면에서는 점선 하천으로 구분해 보인다.

## 나라 영역 — 새로 그린 도식 폴리곤

- 기존 역사 경계 데이터셋은 쓰지 않았다. aourednik/historical-basemaps, CHGIS, 참고 앱(jiangshan-map)의 GeoJSON 모두 쓰지 않았다.
- 교과서 지도 이미지를 따라 그리지 않았다.
- 하천(압록강·두만강·대동강·한강·낙동강·요하), 산맥(소백산맥·철령·자비령), 해안, 만(아산만·남양만·영일만·원산만=영흥만), 위도선(38도선) 같은 지형 기준점의 좌표를 잡았다. 그리고 교과서 서술(예: "청천강~영흥만", "대동강~원산만", "남양만~죽령~영일만")을 근거로 꼭짓점 20~60개 정도의 폴리곤을 새로 그렸다.
- 이웃한 나라는 같은 경계선(꼭짓점 목록)을 함께 쓴다. 그래서 같은 시기 나라 사이에 틈이나 겹침이 생기지 않는다.
- 바다 쪽 꼭짓점은 해안 밖에 두었다. 앱은 나라 면을 Natural Earth 육지 모양으로 잘라(clip) 그리므로 해안선은 바탕 지도 그대로 보인다.
- 모든 도형의 `basis` 속성에 근거 한 줄을 적었다.
- 주변 세력(당·거란·여진·원·명·청·일본·러시아 등)은 위치만 대략 나타낸 회색 면이다. 경계를 정밀하게 그리지 않았다.

## 파일

| 파일 | 내용 |
|---|---|
| `s-<키>.geojson` | 스냅샷별 나라 도형(RFC 7946). 키는 연도(`475`)나 연-월(`1950-08`) |
| `content.json` | 시대 띠, 스냅샷 글(캡션·요약·사건·질문), 나라 한 줄 소개와 색 |
| `labels.geojson` | 바다·하천 이름표 위치 |
| `base-land.geojson`, `base-rivers.geojson` | Natural Earth에서 자른 바탕 지도 |
| `rivers-schematic.geojson` | 대동강 도식선 |
| `data.js` | 위 파일을 묶은 빌드 결과(`window.ATLAS = …`). file://에서 열기 위한 것. 직접 고치지 않는다 |
