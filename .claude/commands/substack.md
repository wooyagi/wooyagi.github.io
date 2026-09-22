구독 중인 Substack 발행처의 최신 글 중 리더에 없는 글을 수집·번역해서 아카이브에 추가하고 GitHub에 푸시한다.

사용법:
  /substack nuttycld              ← 최근 20편 중 없는 글 전부
  /substack nuttycld --limit 5    ← 최근 5편만 검사
  /substack nuttycld <슬러그>      ← 특정 글 1편만
  (파일·본문 첨부 시)              ← 네트워크 대신 첨부된 본문을 사용

발행처 ID = `https://{ID}.substack.com` 의 ID. 커스텀 도메인이면 전체 URL을 그대로 넣어도 된다.

[도구]
암복호화·인덱스 갱신은 전부 `reader/build.mjs` 가 한다. 의존성 없는 Node 스크립트이고,
뷰어(reader/index.html)와 같은 WebCrypto API를 쓰므로 포맷이 어긋날 일이 없다.
.enc 파일을 직접 손으로 만들지 말 것. 반드시 build.mjs 를 거친다.

  node reader/build.mjs status                     보유 현황 (코드 불필요)
  node reader/build.mjs missing <pub> [--limit N]  추가할 글 목록 (코드 불필요)
  node reader/build.mjs fetch <pub> <slug> --out f 글 1편 → 블록 골격 JSON (코드 불필요)
  node reader/build.mjs verify                     입장 코드 확인
  node reader/build.mjs inspect <slug>             기존 글의 실제 스키마 확인
  node reader/build.mjs add <post.json>            번역 완료본 추가 (--dry-run 지원)
  node reader/build.mjs gloss-add <terms.json>     용어집에 새 용어 추가
  node reader/build.mjs selftest                   암호 자가진단

[입장 코드 — 절대 원칙]
- 코드는 READER_CODE 환경변수로만 넘긴다. 명령줄 인자로 쓰지 않는다(히스토리에 남는다)
- 코드·SUBSTACK_SID 를 파일로 저장하거나 커밋하지 않는다. 대화에 다시 출력하지 않는다
- 코드가 없으면 사용자에게 요청한다. 없이는 추가 작업 자체가 불가능하다(기존 인덱스를 못 연다)

[작업 순서]

1. 현황 파악
   node reader/build.mjs status
   node reader/build.mjs missing {발행처} --limit 20 --out /tmp/missing.json
   - 중복 판정은 reader/posts/ 의 파일명(=슬러그)으로 한다. 복호화가 필요 없다
   - 추가 대상이 0편이면 "최신 상태"라고 알리고 종료한다. 빈 커밋을 만들지 않는다
   - 추가 대상 목록(날짜·유료 여부·제목)을 사용자에게 먼저 보여주고 진행한다

2. 입장 코드 확인
   READER_CODE=... node reader/build.mjs verify
   - 틀리면 여기서 멈춘다. 아카이브는 건드리지 않는다

3. 본문 수집 — 글마다
   node reader/build.mjs fetch {발행처} {슬러그} --out /tmp/{슬러그}.json
   - 유료 글(audience=only_paid)은 구독 세션이 있어야 본문이 내려온다.
     SUBSTACK_SID 환경변수가 있으면 자동으로 쓴다. 없으면 사용자에게 본문을 요청한다
   - 네트워크가 막힌 환경이면 fetch 가 그렇게 알려준다. 이때는 사용자가 붙여넣은 본문으로
     같은 형태의 JSON을 직접 만들어 4단계로 간다(블록 분해 규칙은 아래와 동일)

4. 번역·메타 채우기 — fetch 가 만든 JSON의 빈 칸을 채운다
   blocks[i].ko  : 문단별 한국어 번역. 나머지 필드는 건드리지 않는다
   tagline       : 목록 카드에 뜰 한 줄 (40자 내외, 글의 결론을 말해줄 것)
   topics        : 아래 주제 목록에서 1~2개. 첫 번째가 카드 색·섹션을 정한다
   brief         : 필자 문체 가이드. 이 발행처 기존 글의 brief 를 inspect 로 꺼내 그대로 쓴다
                   (없으면 새로 쓰되, 같은 발행처 글끼리는 동일하게 유지할 것)
   summary       : 핵심 요약 HTML. 기존 글은 <p><strong>무슨 일이 있었나.</strong> … 형식을 쓴다.
                   같은 발행처 기존 글을 inspect 로 확인해 형식을 맞출 것
   ※ words·images 는 add 가 본문에서 자동 계산한다. 직접 넣지 않는다

   [번역 규칙]
   - 블록과 1:1 로 옮긴다. 합치거나 쪼개지 말 것. 원문(html)과 짝이 어긋나면 문단 펼치기가 깨진다
   - 뉴스레터 톤. 필자가 한국어로 쓴 것처럼 자연스럽게. 직역투·번역기 문체 금지
   - 숫자·단위·티커·제품명(HBM3E, 800V, GB300 등)은 원문 그대로 유지한다
   - 업계에서 영어로 통용되는 용어는 음차하지 말고 영어를 살린다 (CPO, SerDes, 인터포저)
   - ko 가 <ul>·<blockquote>·<table> 로 시작하면 뷰어가 그대로 쓰고, 아니면 type 태그로 감싼다.
     따라서 목록·인용·표는 ko 도 같은 태그로 통째로 작성한다
   - type:"image" 블록은 ko 에 캡션 번역만 넣는다. 없으면 비워둔다
   - 추측으로 내용을 보태지 않는다. 원문에 없는 수치·주장을 만들지 않는다

   [주제 목록 — reader/index.html 의 TOPICS]
   메모리·HBM / NVIDIA·AI 인프라 / 반도체 패키징 / 광통신·인터커넥트 / 네트워킹·SerDes /
   AI 인프라·데이터센터 / 전력·에너지 / 반도체·투자 전략 / 제조·수율 / 위성통신·RF
   - 여기 없는 주제를 쓰면 회색 📄 로 폴백된다. add 가 경고한다
   - 새 주제가 꼭 필요하면 index.html 의 TOPICS 에 이모지·색과 함께 추가하고 사용자에게 알린다

5. 추가
   READER_CODE=... node reader/build.mjs add /tmp/{슬러그}.json --dry-run   ← 먼저 확인
   READER_CODE=... node reader/build.mjs add /tmp/{슬러그}.json
   - add 가 posts/{슬러그}.enc 생성 + index.enc·search.enc·meta.json 갱신까지 한꺼번에 한다
   - 검증에 걸리면(번역 누락, 주제 없음, 중복 슬러그) 아무것도 쓰지 않고 멈춘다. 고친 뒤 다시 돌린다
   - 여러 편이면 한 편씩 순서대로. 실패한 편은 건너뛰고 나머지를 마저 처리한 뒤 보고한다

6. 용어집 (선택)
   새 글에 기존 용어집(95개)에 없는 핵심 개념이 나오면 추가한다.
   [{"id":"kebab-case","term":"용어 (English)","cat":"분류","def":"쉬운 설명. 다른 용어는 [[id]] 로 링크","match":["본문에 나오는 표기","영문 표기"]}]
   READER_CODE=... node reader/build.mjs gloss-add /tmp/terms.json
   - match 의 단어가 본문에 처음 나올 때 자동으로 링크가 걸린다. 너무 흔한 단어는 넣지 않는다
   - 글 한 편당 2~3개를 넘기지 않는다. 링크가 과하면 본문이 지저분해진다

7. 확인 후 푸시
   node reader/build.mjs status        ← n 과 실제 파일 수가 맞는지
   git add reader/ && git commit -m "reader: update {YYYY-MM-DD_HHMM}" && git push -u origin main
   - 커밋 메시지는 기존 이력과 같은 형식을 쓴다
   - git status 로 의도한 파일만 바뀌었는지 확인한다. .json 중간 산출물이 섞이지 않게 한다
   - 푸시 후 추가된 글 제목·편수를 사용자에게 보고한다

[하지 말 것]
- 기존 글·용어집 항목 수정 (이 명령은 추가 전용이다)
- .enc 파일 직접 편집
- 입장 코드·세션 쿠키를 저장소·커밋·대화에 남기기
- 원문을 못 구한 글을 요약만으로 채워 넣기 (수집 실패로 보고하고 건너뛴다)
