<!--
出所: ChatGPT（GPT-5 系）との調査セッション。2026-09-04 に noricha-vr が保存した原文をそのまま取り込んだもの。
編集しないこと（原文の保全が目的）。要約・決定・エージェントが読む正本は ../streaming/region-and-traffic-plan.md。
未検証の外部情報を含む（末尾に ChatGPT 自身の注意書きあり）。数値は必ず一次情報で裏を取ること。
-->

# サーバー比較調査

#### ChatGPT:

45m 20s考えました

## 結論

**WebScreenの本番配信サーバーは、WebARENA Indigoから「Cherry Servers 東京のベアメタル」へ移すのが現時点の第一候補です。**

ただし、いきなり1社へ全面依存するより、次の構成が向いています。

役割

推奨

主系

**Cherry Servers 東京・Ryzen 9700X**

副系・オーバーフロー

**自前10Gbps回線＋自前Linuxサーバー**

国内帯域保証が必要な場合

**KAGOYA FLEX 500Mbps／1Gbps占有回線**

地理・事業者分散

**OVHcloudシンガポール GAME-1**

安価な実験用

KAGOYA CLOUD VPS 4GB

非推奨

IndigoPro、安価な共有VPSの大量並列

Cherry東京は価格と転送量が圧倒的です。一方で東京拠点の開設が2026年5月と新しく、実運用実績が短いため、**Cherry主系＋自前回線副系**が最もバランスのよい構成です。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers+1](https://www.cherryservers.com/blog/cherry-servers-tokyo-location-live)

---

## WebScreenで本当に必要な帯域

現在のWebScreenは、

-   映像：H.264を再エンコードせずコピー
    
-   音声：AACへ変換
    
-   VRChat視聴：RTSP over TCPによるユニキャスト
    
-   1視聴者あたり実測：約**1.385Mbps**
    
-   現在の同時配信上限：20配信
    

という構成です。したがってCPUよりも、**サーバーから視聴者への上り帯域と総転送量**が支配的です。

40人が同じ配信を見る場合は、次の負荷になります。

40人ワールド数

ピーク送信帯域

1日4時間・月30日の転送量

1ワールド

55.4Mbps

2.99TB

2ワールド

110.8Mbps

5.98TB

5ワールド

277Mbps

14.96TB

10ワールド

554Mbps

29.92TB

20ワールド

1.108Gbps

59.83TB

20人なら、おおよそこの半分です。

1ワールド40人を24時間連続で流した場合は、**月17.95TB**です。

安全率を現在の70%とすると、回線ごとの40人ワールド収容数は次の式で求められます。

```
安全に収容できる40人ワールド数
= floor（実測持続上りMbps × 0.7 ÷ 55.4）
```

実測持続上り

40人ワールド数

100Mbps

1

300Mbps

3

500Mbps

6

1Gbps

12

2Gbps

25。ただし現在の20配信上限が先に効く

---

# 1位：Cherry Servers 東京ベアメタル

## 推奨プラン

**AMD Ryzen 9700X**

-   8コア16スレッド
    
-   RAM 96GB
    
-   NVMe 1TB×2
    
-   10Gbpsアップリンク
    
-   月20TBまで
    
-   月額€237.15
    
-   超過転送量：€1.69/TB
    
-   稼働率SLA：99.97%
    

WebScreenにはCPUもRAMも過剰ですが、**10Gbpsポートと安い転送量を買うプラン**と考えるのが正しいです。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers+2![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers+2](https://www.cherryservers.com/bare-metal-dedicated-servers/tokyo)

### WebScreenでの費用イメージ

利用量

月間転送

概算費用

40人×1ワールド・24時間

17.95TB

€237.15

40人×5ワールド・毎日4時間

14.96TB

€237.15

40人×10ワールド・毎日4時間

29.92TB

約€253.91

40人×20ワールド・毎日4時間

59.83TB

約€304.47

税・為替は別として、20ワールドを動かしても、国内の帯域保証回線と比べてかなり安価です。

ただし、転送量が上限に近づくと100Mbpsまで制限される可能性があります。追加転送枠は管理画面から購入できますが、反映まで最大1時間と案内されているため、**70%・85%・95%で通知し、100%到達前に追加購入**する必要があります。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/knowledge/docs/usage-billing/bandwidth-plans)

### 注意点

Cherryの東京ページは、上部に「100TB」と書かれている一方、Ryzen 9700Xのプラン表示とAPAC向け公式帯域資料は「20TB」です。今回は保守的に**20TBを正**として計算しています。契約前に書面で確認すべきです。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers+1](https://www.cherryservers.com/bare-metal-dedicated-servers/tokyo)

また、10Gbpsはアップリンク速度であり、1Gbps以上の持続送信が保証されているとは明記されていません。したがって、

-   600Mbps連続
    
-   1.2Gbps連続
    
-   TCP接続800本
    
-   72時間
    
-   日本国内の複数ISPから接続
    

の負荷試験を通してから主系へ昇格させます。

---

# 2位：自前10Gbps回線＋自前サーバー

## 最も現実的な2回線構成

### 回線A：フレッツ光クロス＋INTERLINK ZOOT PREMIUM

-   最大10Gbps・ベストエフォート
    
-   IPv4固定IP 1個
    
-   IPv6 IPoE／IPIP
    
-   ISP側の大量データ通信制御なし
    
-   フレッツ光クロス対応
    
-   1～2年目：約14,960円／月
    
-   3年目以降：約16,500円／月
    
-   ルーター・電気代・サーバー代を除く
    

内訳は、フレッツ光クロス4,180円または5,720円と、ZOOT PREMIUM 10,780円です。[![](https://www.google.com/s2/favicons?domain=https://flets-w.com&sz=128)NTT西日本公式｜フレッツ光｜光インターネット接続（光回線）+1](https://flets-w.com/service/cross/price/)

「大量データ通信制御なし」と明記されているため、一般家庭向けISPより動画配信に向いています。ただし回線自体はベストエフォートで、帯域保証ではありません。

### 回線B：オフィスeo光 10G・固定IP

-   最大概ね10Gbps
    
-   固定IPv4付き
    
-   月額13,090円
    
-   オプテージがバックボーンから宅内まで自社設備として運用
    
-   和歌山の設置住所で提供可否確認が必要
    

NTT系とは別の回線網なので、フレッツ光クロスとの組み合わせで障害分散になります。[![](https://www.google.com/s2/favicons?domain=https://office-eo.jp&sz=128)オフィスeo光+1](https://office-eo.jp/internet/?utm_source=chatgpt.com)

一方、他利用者や設備へ重大な影響を与える場合は最大速度を制限することがあるため、こちらも事前申告が必要です。[![](https://www.google.com/s2/favicons?domain=https://optage.co.jp&sz=128)オプテージ](https://optage.co.jp/business/service/network/internet/office/price.html?utm_source=chatgpt.com)

### 2回線合計

期間

月額合計

1～2年目

約28,050円

3年目以降

約29,590円

機材・電気代を加えても、転送量単価ではデータセンターよりはるかに安くなります。

---

## 自前サーバーに必要な性能

WebScreenではGPUは不要です。優先順位はCPUよりネットワークです。

推奨構成は次の程度です。

-   Linux
    
-   物理4～8コア
    
-   メモリ16～32GB
    
-   10GbE NIC
    
-   システムSSDをRAID1
    
-   UPS
    
-   遠隔電源制御
    
-   温度監視
    
-   予備ルーター
    
-   予備NIC
    
-   systemdによるMediaMTX・ffmpeg自動復旧
    

現在の実測では、800視聴者でもMediaMTX側のreader処理はCPU約1～2コア相当で、20本の音声変換も大きな負荷ではありません。高性能GPUサーバーを買うより、**NIC、ルーター、UPS、回線冗長化へ予算を使う方が効果的**です。

現在の構成では少なくとも、外部から以下が到達する必要があります。

-   TCP 554：VRChatのRTSP視聴
    
-   TCP 80／443：証明書・WHIP
    
-   UDP 8189：WebRTCメディア
    

通常の家庭用ルーターではなく、10GbpsでNAT・ファイアウォール・IPIPを処理できる機器が必要です。

---

## 自前回線をたくさん束ねるべきか

**回線をボンディングするのではなく、ワールド単位で割り当てるべきです。**

RTSPは1視聴者ごとのTCP接続なので、複数回線を束ねても1本の接続が複数回線へ分割されるわけではありません。MPTCPやトンネルで無理に束ねると、結局は集約先のクラウドサーバーが全転送量を受けるため、自前回線の利点が薄れます。

推奨する割り当て単位は次のとおりです。

```
1配信＝60Mbps予約
```

40人×1.385Mbpsの55.4Mbpsに少し余裕を持たせます。

D1には、例えば以下を持たせます。

```
edge_nodes
- id
- status
- measured_capacity_mbps
- reserved_mbps
- egress_30d_bytes
- provider
- location

streams
- id
- owner_edge_id
- reserved_mbps
- publisher_status
```

配信開始時に、Astro／Worker側が空き容量のあるedgeを選び、D1上で60Mbpsを原子的に予約します。

### 重要な制約

`stream.web-screen.net`をサーバーごとのホスト名へ変更してはいけません。

複数Aレコードを設定するだけでは、視聴者が配信を持っていないノードへ接続する可能性があります。複数台化する場合は、すべてのedgeが任意の配信pathを読めるようにします。

```
配信者
  ↓ WHIP
owner edge
  ↓ RTSP 1本だけ
別edgeのMediaMTX read replica
  ↓
そのedgeに接続したVRChat視聴者へ配信
```

これなら、別edgeは配信ごとに1本だけownerから取り寄せ、視聴者への大量配信は各edgeの回線から出せます。

最初は複雑にせず、

1.  Cherry東京をactive
    
2.  自前回線をstandby
    
3.  DNS切り替えによる障害復旧
    
4.  利用増加後にread replica化
    

の順が安全です。

---

# 3位：KAGOYA FLEXの帯域占有

KAGOYA FLEXには、

-   100Mbps占有
    
-   300Mbps占有
    
-   500Mbps占有
    
-   1Gbps占有
    

があり、それぞれプラン上限まで帯域流量が保証されます。現在の価格は問い合わせ制です。[![](https://www.google.com/s2/favicons?domain=https://www.kagoya.jp&sz=128)KAGOYA](https://www.kagoya.jp/option/network-bandwidth_upgrade/)

WebScreenでの収容目安は次のとおりです。

占有帯域

40人ワールド数

100Mbps

1

300Mbps

3

500Mbps

6

1Gbps

12

国内・日本語サポート・帯域保証という意味では最も堅実です。

ただし最大20ワールドを受けるには、1Gbps回線が2系統必要です。価格次第ではCherry東京より何十倍も高くなる可能性があります。

**法人向けに確実なSLAを求められるようになった段階で採用する選択肢**です。

---

# 4位：OVHcloudシンガポール

OVHcloud GAME-1は、

-   Ryzen 7 9800X3D
    
-   RAM 64GB
    
-   1Gbps unmetered
    
-   1Gbps guaranteedとの案内
    
-   Game DDoS Protection
    
-   月額US$331、初期費用US$331
    

です。[![](https://www.google.com/s2/favicons?domain=https://www.ovhcloud.com&sz=128)OVHcloud+1](https://www.ovhcloud.com/asia/bare-metal/game/)

1Gbpsなので、70%運用では40人ワールド約12個が上限です。

東京よりネットワーク距離が長いため主系にはCherry東京を優先しますが、

-   Cherry障害時のDR
    
-   自前回線が開通するまでの副系
    
-   事業者と地域を完全に分離したい場合
    

には適しています。

---

# KAGOYA CLOUD VPSは「試験用」

KAGOYA CLOUD VPSは、4GB・4コアで月額1,760円です。転送量自体の上限はありません。[![](https://www.google.com/s2/favicons?domain=https://www.kagoya.jp&sz=128)KAGOYA+1](https://www.kagoya.jp/vps/function-plan/)

しかし公式FAQには、極端に転送量が多い利用者について、同時に占有できる帯域を調整する場合があると明記されています。

したがって、

-   1～2ワールドでの試験
    
-   Cherry契約前の比較計測
    
-   短期的なオーバーフロー
    
-   7日間程度の連続負荷試験
    

には向きますが、本番の最大容量をKAGOYA VPSの「最大1Gbps」を前提に計算するべきではありません。

安価なVPSを10台並べても、同じ事業者の共有回線・フェアユース規定に依存する問題は残ります。

---

# Indigo・IndigoProが適さない理由

Indigo 8GBは、月額3,410円、1Gbps上限ですが、安定運用の目安は1日160GBです。40人ワールドでは約6.4時間で160GBへ到達します。[![](https://www.google.com/s2/favicons?domain=https://web.arena.ne.jp&sz=128)WebARENA+1](https://web.arena.ne.jp/indigo/)

IndigoProは10Gbps上限ですが、転送量目安が月6TBです。40人ワールド1つでも、1日約8時間で月6TBに到達します。[![](https://www.google.com/s2/favicons?domain=https://web.arena.ne.jp&sz=128)WebARENA+1](https://web.arena.ne.jp/indigopro/)

したがって、

-   Indigo：瞬間帯域はあるが日次転送量が小さい
    
-   IndigoPro：10Gbpsだが月間転送量が小さい
    

という状態です。どちらも動画の継続配信には合いません。

---

# 推奨する実際の移行順

## Phase 1：Cherry東京を1台検証

Cherry東京のRyzen 9700Xを月額契約し、現在のversioned MediaMTX設定をそのまま移植します。

次の負荷を通します。

-   600Mbps連続・72時間
    
-   1.2Gbps連続・数時間
    
-   TCP reader 800接続
    
-   WHIP 20配信
    
-   UDP 8189の安定性
    
-   東京・大阪・和歌山・モバイル回線からのRTSP再生
    
-   packet loss、再接続、初回表示時間
    
-   1日単位・30日ローリング転送量監視
    

合格後にDNSをCherryへ向けます。Indigoはすぐには解約せず、ロールバック先として残します。

## Phase 2：自前回線を1本開通

第一候補は、

```
フレッツ光クロス
＋
INTERLINK ZOOT PREMIUM
```

です。

500Mbps以上の持続上りが取れれば、40人ワールド6本を安全に収容できます。

## Phase 3：別キャリアを追加

オフィスeo光10G固定IPを別拠点、または同一拠点の第二回線として追加します。

同一建物へ2回線引くより、

-   会社：オフィスeo
    
-   自宅：フレッツ光クロス
    
-   東京：Cherry Servers
    

のように物理拠点も分けた方が、停電・工事・ルーター障害・地域障害に強くなります。

## Phase 4：D1のstream placementを有効化

1配信60Mbps単位で、

-   Cherry
    
-   自宅edge
    
-   会社edge
    

へ割り当てます。

同一ホスト名を維持し、各edgeがread replicaとして任意pathを取得できるようにした後で、DNSまたはヘルスチェックによる分散を始めます。

---

## 契約前に送る確認文

Cherry、KAGOYA、INTERLINK、オプテージへ、ほぼ同じ内容を送るべきです。

```
用途：
VRChat向けのリアルタイム画面共有サービスです。
ブラウザからWebRTC/WHIPで受信し、
視聴者へRTSP over TCPでユニキャスト配信します。

通信量：
・1視聴者あたり：約1.385Mbps
・1配信あたり：最大40視聴者、約55.4Mbps
・同時配信：初期5～10本、最大20本
・初期ピーク送信帯域：約600Mbps
・最大ピーク送信帯域：約1.2Gbps
・月間送信量：初期15～30TB、最大60TB程度
・主な利用時間：日本時間の夜間
・映像の再エンコードは行わず、中継が中心です

確認事項：
1. この用途と通信量は利用規約上許可されるか
2. 長時間の600Mbps～1.2Gbps送信で速度制限されるか
3. Fair Use Policyや非公開の帯域制限があるか
4. 速度制限が行われる具体的条件
5. TCP 554とUDP 8189を利用できるか
6. DDoS攻撃時の対応
7. 転送量超過前の通知・追加枠購入方法
8. 回答内容を契約上の前提として保存してよいか
```

**最終的な採用案は「Cherry東京を主系、自前のフレッツ光クロス＋ZOOT PREMIUMを副系、オフィスeoを将来の第二自前回線」です。**  
KAGOYA FLEXは帯域保証が必要になった時の法人向け上位選択肢、OVHシンガポールは地理・事業者分散用とするのが適切です。

![](https://www.google.com/s2/favicons?domain=https://www.interlink.or.jp&sz=32)

![](https://www.google.com/s2/favicons?domain=https://flets-w.com&sz=32)

![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=32)

情報源

  

今日 10:35

#### あなた:

![Screenshot 2026-09-04 10.32.10.png](https://chatgpt.com/backend-api/estuary/content?id=file_0000000051a882099b2213ac20b5feda&ts=496803&p=fs&cid=1&sig=790e10992e6fd9986db5732d4d4e048c595b99a0246f6817e314c0718e7864d3&v=0)

![Screenshot 2026-09-04 10.33.44.png](https://chatgpt.com/backend-api/estuary/content?id=file_00000000267882068612b8f9af8f3173&ts=496803&p=fs&cid=1&sig=cbc77077598cdc0b4dff444d8c356580e423e0cc87438ab74f526e44f7e06d0e&v=0)

無料で提供する分には、レイテンシを最小にする以外にも、トラフィックのコストを最小に抑えるというニーズがあります。 例えば Cherry サーバーの場合、トラフィックのコストが日本のリージョンとそれ以外のリージョンとで、3倍くらいの開きがあることが分かりました。そのため、日本ではない離れたリージョンを使い、安いトラフィックを利用するというのが、ウェブスクリーンにおいて合理的な選択になることが分かりました。 そこで調査してほしいのは、VRChat のユーザーはおそらくアメリカ、日本、ヨーロッパに広く分布していて、メインで使うのは日本人ですが、残りの半分に関しては海外からの流入もあると考えられます。 そのため、どこの国にサーバーを置くと一番全体でレイテンシが少なくなるのかを、ここの利用できるサーバーリストの中から提案してください。 例えばヨーロッパの場合、日本とのレイテンシが非常に大きく、アメリカに置くと日本とヨーロッパとのレイテンシが大体同じくらいになって、意外にアメリカが利用者の真ん中になるのではないかというのが私の仮説です。

表示を増やす表示を減らす

  

#### ChatGPT:

3m 36s考えました

結論として、**今のWebScreenなら Chicago を無料枠の標準配信リージョンにするのがかなり合理的です。**  
しかも、のりちゃんの「日本・北米・欧州の真ん中は、意外とアメリカになるのでは」という仮説は、ネットワーク距離で見るとかなり当たっています。

特に今回の候補の中では、**Chicago が「平均レイテンシ」「最悪レイテンシ」「トラフィック単価」の3つを同時にかなり良い位置で満たしています。**

### ざっくり比較

仮にWebScreen利用者を、

-   日本：50%
    
-   北米：25%
    
-   欧州：25%
    

と置きます。

2026年8月のネットワーク実測では東京→Singaporeは約69ms、Frankfurt約193ms、Amsterdam約197ms、米国西海岸は85〜101ms、米国東海岸は143ms前後です。[![](https://www.google.com/s2/favicons?domain=https://hatsnet.io&sz=128)ハッツネットワーク](https://hatsnet.io/docs/network/latency/tyo-tokyo)  
またCherry Chicagoサーバーの外部ベンチマークでは、Tokyo約120〜132ms、Amsterdam約90ms、Frankfurt約102ms、Singapore約202msという実測例があります。[![](https://www.google.com/s2/favicons?domain=https://www.letshosting.com&sz=128)LetsHosting+1](https://www.letshosting.com/6531.html?utm_source=chatgpt.com)

これらから実運用を想定したレンジで置くと、こんな感じになります。

サーバー

日本ユーザー

北米ユーザー

欧州ユーザー

50/25/25 加重平均

評価

**Chicago**

125〜145ms

20〜60ms

85〜105ms

**約100〜110ms**

🥇

Singapore

70〜85ms

160〜240ms

155〜180ms

約120〜140ms

🥈

Frankfurt

190〜220ms

85〜140ms

5〜25ms

約125〜145ms

3位

Amsterdam

195〜220ms

80〜145ms

5〜20ms

約125〜145ms

ほぼ同率

Stockholm

200ms超

100ms前後〜

10〜30ms

約140ms超

△

Lithuania

235〜245ms程度

110〜170ms

20〜40ms

約160ms前後

×

ここで重要なのは、\*\*Chicagoだけ「どの地域からも致命的に遠くない」\*\*ことです。

Singaporeは日本人には最高ですが、米国東海岸から200ms超になることがあります。Cherry Singaporeの実測でもLos Angeles約163ms、New York約244ms、Amsterdam約159msという値が出ています。[![](https://www.google.com/s2/favicons?domain=https://www.letshosting.com&sz=128)LetsHosting+1](https://www.letshosting.com/15681.html?utm_source=chatgpt.com)

逆に欧州に置くと、日本人がほぼ常時200ms級になります。

Chicagoの場合、

> 日本 ≈ 130ms  
> 北米 ≈ 0〜60ms  
> 欧州 ≈ 90〜105ms

くらいに収まりやすい。

**「誰か一地域を犠牲にせず、世界全体の最大値を小さくする」というmin-max戦略ではChicagoがかなり強いです。**

---

## さらにWebScreenの場合、Chicagoが普通のWebサービス以上に理にかなう

WebScreenは、

```
配信者
 ↓
サーバー
 ↓
VRChat視聴者
```

なので、本当に見るべきなのは単純な「視聴者 → サーバー RTT」ではありません。

たとえば配信者が日本にいる場合。

### 日本人 → 日本人

Singaporeなら、

```
日本 → Singapore → 日本
≈ 70〜85ms分のネットワーク遅延
```

Chicagoなら、

```
日本 → Chicago → 日本
≈ 125〜140ms
```

なのでSingaporeが**約55〜60ms有利**です。

ところが日本人配信者 → 欧州視聴者なら、

```
日本 → Chicago     約65ms one-way
Chicago → 欧州     約45〜50ms one-way

合計 約110ms
```

一方Singaporeでも、

```
日本 → Singapore   約35〜40ms
Singapore → 欧州   約80ms

合計 約115〜120ms
```

となり、**ほとんど差がなくなります。**

北米視聴者の場合は逆にChicagoがかなり有利です。

つまりChicagoは、

**日本人視聴者には+50〜60msを支払う代わりに、世界配信全体をかなり均一化する場所**

と考えると分かりやすいです。

---

## しかも、その50〜60msに対してコスト差がものすごく大きい

ここがWebScreenでは決定的です。

現在のCloud VDS 2だと、

**Chicago**

-   1Gbps
    
-   **10TB/月無料**
    
-   超過 **€0.50/TB**
    

です。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/pricing/virtual-servers/g1-4-16gb-100nv-ded?region=us-chicago)

**Singapore**

-   1Gbps
    
-   **3TB/月無料**
    
-   超過 **€1.69/TB**
    

です。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/pricing/virtual-servers/g1-4-16gb-100nv-ded?region=sg-singapore)

Cherryの公式帯域規約でも、米国・欧州とAPACは別料金体系になっています。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/knowledge/docs/usage-billing/bandwidth-plans?utm_source=chatgpt.com)

つまり単に

**€0.50 vs €1.69 = 3.38倍**

だけではありません。

無料転送量も、

**10TB vs 3TB**

です。

例えば月100TB配信すると、

Chicago

Singapore

無料

10TB

3TB

課金対象

90TB

97TB

追加転送料

**€45**

**€163.93**

です。

サーバー本体価格が同じなら、**月約€119差**になります。

1PBまで伸びれば、おおよそ、

-   Chicago：約€495
    
-   Singapore：約€1,685
    

です。

無料サービスでは無視できない差です。

---

# 日本人比率がもっと高かったらどうなるか

ここも計算しました。

代表RTTを、

```
Chicago
JP 132 / NA 45 / EU 95

Singapore
JP 75 / NA 200 / EU 160
```

として単純加重すると、

ユーザー構成

Chicago

Singapore

純粋なレイテンシ勝者

JP50 / NA25 / EU25

**101ms**

128ms

Chicago

JP60 / NA20 / EU20

**107ms**

117ms

Chicago

JP70 / NA15 / EU15

113ms

**107ms**

Singapore

JP80 / NA10 / EU10

120ms

**96ms**

Singapore

だいたい**日本人が65〜70%を超えてくると、純粋な平均レイテンシではSingaporeが勝ち始める**と考えてよさそうです。

ただし面白いのはJP70%でも、

> Singapore：約107ms  
> Chicago：約113ms

差が**6〜7ms程度**しかないことです。

それに対して転送量は**3.38倍**。

なので、

### WebScreenの無料提供

なら、日本人が70%程度になっても、私はまだChicagoを選びます。

80〜90%が日本人になって、初めてSingaporeを真剣に考えるくらいです。

---

# もう一つ重要：現在のWebScreenでは50msの差はそこまで大きくない

現在のWebScreenのAAC経路では、同じYamaStreamでRTSPTの中央値が約**1.239秒**という実測になっています。

そこへ、

-   Singapore：+70ms程度
    
-   Chicago：+130ms程度
    

なので、

```
Singapore  ≈ 1.31秒
Chicago    ≈ 1.37秒
```

くらいの違いになります。

実際にはバッファなどがあるので単純加算ではありませんが、\*\*ユーザー体感で0.06秒程度のために転送料を3.38倍払うのか？\*\*という判断になります。

無料サービスなら答えはかなり明確で、

**払わなくていいと思います。**

逆に将来MP3経路などでWebScreen本体の遅延が150ms級まで下がれば、50〜60msはかなり大きな割合になるので、その時はマルチリージョン化する価値が上がります。

---

# 今回の6候補ならこう順位付けします

**1位：Chicago**  
無料版の標準リージョン。世界全体のレイテンシが最も均等で、€0.50/TB。

**2位：Singapore**  
日本・アジア向け低遅延サーバー。ただし€1.69/TBなので無料版にはもったいない。

**3位：Amsterdam / Frankfurt**  
欧州ユーザーがかなり多くなった時のedge用。日本メインの単一リージョンには向かない。

**4位：Stockholm**  
欧州の中でも北に寄りすぎています。WebScreenのグローバル拠点として選ぶ理由は薄いです。

**5位：Lithuania**  
安いですが、日本にも北米にも遠い。Cherryの本拠地としてのコストメリットが相当ない限り選ばなくてよさそうです。

そして現在の画面を見る限り、在庫があるのは主に

-   Chicago
    
-   Singapore
    
-   Lithuania
    

なので、**今契約するならChicagoでほぼ迷わなくていい**と思います。

---

## 長期的には「無料＝Chicago」がかなりきれい

私はWebScreenをこう分けるのが合っていると思います。

```
WebScreen 無料
        │
        └── Chicago
            10TB込み
            €0.50/TB
            世界中にそこそこ速い

WebScreen 高速配信（将来）
        │
        ├── Tokyo / Singapore   日本・アジア
        ├── Chicago             北米
        └── Amsterdam           欧州
```

無料ユーザーには**コスト効率最優先のChicago**。

もし将来有料プランを作るなら、

> 「近い配信サーバーを自動選択して低遅延化」

を有料側の価値にできます。

これはかなり理にかなった差別化です。

ちなみにCherry自身もChicagoを「North Americaのdigital crossroads」と説明していて、上流にはArelion・DataPacket・Lumen・NTTを持っています。欧州側もAmsterdam–Frankfurt 7msなどかなり密につながっているので、単なる地理上のChicago以上に世界向け中継地点として使いやすいネットワークです。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/network/locations)

**なので今回の仮説については、「アメリカ」よりさらに具体的に「Chicagoがちょうどいい」が結論です。**

次にやるなら、Cherryが公式に用意している `speedtest.us.cherryservers.com` を使って、**日本の自宅回線→Chicagoの実RTTを測定し、今使っているIndigoとのWebScreen実機A/Bテスト**までやると、かなり確信を持って移行できます。Cherryは各リージョン用のspeedtestホストを公開しています。[![](https://www.google.com/s2/favicons?domain=https://speedtest.us.cherryservers.com&sz=128)speedtest.us.cherryservers.com+1](https://speedtest.us.cherryservers.com/)

  

#### あなた:

![Screenshot 2026-09-04 10.46.53.png](https://chatgpt.com/backend-api/estuary/content?id=file_000000002a348211a3530e86e9808d28&ts=496803&p=fs&cid=1&sig=df4162411dfa1638e4466509e941589bb7a3615865b7433bdd68acf6080fcd3e&v=0)

![Screenshot 2026-09-04 10.47.56.png](https://chatgpt.com/backend-api/estuary/content?id=file_000000007bc481f88777bc1b9e31315e&ts=496803&p=fs&cid=1&sig=8f0aaf854aab737fb2cacac480dbebf4f6c9ab576f44c7dee3fb67c1b8969d1f&v=0)

VSD 2だと20Tまでしかトラフィックを選択できません。 一方、トラフィックだけを購入しようとすると、このように20TB以上も選択できます。 これはサーバーを契約する画面のドロップダウンが制限されているだけで、実際には追加で購入した分が利用できる料金プランになっているのか調査をお願いします。 契約するサーバーのサイズに応じてトラフィック量の初期値が決まっているのはわかりますが、上限をどこまで上げられるのかを調査してください。 ウェブスクリーンを始めるにあたって、負荷に合わせてサーバーの大きさを選択できるのか、それとも負荷に関係なく、トラフィック量によって選択できるサーバーの選択肢が絞られてしまうのかが知りたいです。

表示を増やす表示を減らす

  

#### ChatGPT:

1m 19s考えました

結論から言うと、**Cloud VDS 2 の「20TBまで」はサーバー自体のトラフィック上限ではありません。**  
Cherry Serversは「計算資源」と「月間トラフィック枠」をかなり明確に分離していて、**VDS 2を10TB付きで契約し、あとからプロジェクト側に100TB、500TB、1000TBとトラフィックを追加する運用ができます。**

つまりWebScreenでは、かなり理想的に

> **CPU/RAMは実際の負荷に合わせて小さいサーバーを選ぶ**  
> ＋  
> **転送量だけ必要なだけ追加購入する**

という選び方ができます。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers+1](https://www.cherryservers.com/knowledge/docs/usage-billing/bandwidth-plans?utm_source=chatgpt.com)

### 20TBのドロップダウンは何なのか

スクリーンショットのCloud VDS 2では、

-   10TB：Included
    
-   15TB：+€2.5/月
    
-   20TB：+€5/月
    

となっています。

これは**VDS 2に紐づけて注文時に選べる初期トラフィックパッケージの範囲**です。Cherry公式もCloud VDSについて「月10〜20TB」としつつ、直後に「Additional bandwidth can be requested」と明記しています。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/knowledge/docs/compute/virtual-servers/cloud-vds)

そしてCherryの帯域仕様には、もっと決定的な説明があります。

> サーバーごとのトラフィック枠は、プロジェクト全体で加算される。  
> 各サーバーは自分に付いている枠に制限されず、プロジェクト全体の枠を使える。

公式例では「100TB付きサーバー＋20TB付きVDS＝プロジェクト120TB」となり、**20TB付きVDS単独で115TB使っても構わない**と説明されています。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/knowledge/docs/usage-billing/bandwidth-plans?utm_source=chatgpt.com)

なので例えば、

```
Cloud VDS 2
  10TB Included

＋ Additional Traffic
  200TB

＝ プロジェクト全体
  210TB / 30日
```

として、**そのVDS 2が210TB近く使うこと自体は制度上問題ありません。**

---

## 1000TBまで本当に追加できるのか

ここもほぼYESです。

今回のポータルではStandaloneの「Additional traffic package」で、

**1TB〜1000TB**

まで選べています。

しかもCherry公式ドキュメントにも、この別売りTraffic packageを注文すると、**約1時間後に新しいトラフィック枠が全active serverへ適用される**と明記されています。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/knowledge/docs/usage-billing/bandwidth-plans?utm_source=chatgpt.com)

さらにAPIにも、

```
PATCH /v1/traffic/{trafficId}

adjust: 必要なTB数
```

という「Request more traffic」APIが正式にあります。[![](https://www.google.com/s2/favicons?domain=https://api.cherryservers.com&sz=128)Cherry Servers](https://api.cherryservers.com/doc/?utm_source=chatgpt.com)

したがって、これはUIだけの飾りではありません。**プロジェクトの月間トラフィック枠を後から増やす正式な仕組み**です。

### ただし「1000TBが絶対的な最終上限」かは未確認

ここだけは区別した方がいいです。

現在確認できるのは、

**ポータルの1回の購入UI：最大1000TB**

です。

一方で公開ドキュメントには、

> Project maximum = 1000TB

というハード上限の記載はありません。

APIの`adjust`にも公開仕様上の最大値は書かれていません。また公式説明は「複数のservers and traffic plansを合算する」という設計です。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers+1](https://www.cherryservers.com/knowledge/docs/usage-billing/bandwidth-plans?utm_source=chatgpt.com)

なので現状は、

**「少なくとも1000TBまでは正式に購入可能。1000TB超が可能かは公開仕様からは断定できない」**

が正確です。

WebScreenで1000TBを超え始める段階なら、どのみちVDS 2一台では帯域的に無理なので、その時点ではサーバー構成自体が変わります。

---

# ここが大事：トラフィック量と「通信速度」は別

追加Traffic packageで増えるのは、

**月間に送信してよい総量**

です。

VDS 2自体のネットワークポートは**1Gbpsのまま**です。追加で1000TB買っても10Gbpsにはなりません。Cherryも「bandwidth speed allowancesは個々のserver planに紐付き、traffic packageを買っても変化しない」と明記しています。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/knowledge/docs/usage-billing/bandwidth-plans?utm_source=chatgpt.com)

Cloud VDS 2の現在の仕様は、

項目

Cloud VDS 2

CPU

4 vCore / 2物理コア

RAM

16GB

NVMe

100GB

ポート

**1Gbps**

初期Egress

10TB

Chicago月額

**€29/月（現在のセール価格）**

です。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/pricing/virtual-servers/g1-4-16gb-100nv-ded)

したがってWebScreenでは、

**月間転送量** → Traffic packageで解決  
**瞬間同時接続数** → 1Gbpsポートで決まる

という二つを別々に考える必要があります。

---

# WebScreenに当てはめると

現行WebScreenでは視聴者1人あたり実測約**1.385Mbps**なので、40人ワールドなら、

**約55.4Mbps**

です。

Cloud VDS 2の1Gbpsを70%程度まで使う設計なら、

```
700Mbps ÷ 55.4Mbps
≈ 12ワールド
```

つまり、

**40人満員ワールドを約12個同時配信**

くらいが1Gbpsサーバーの安全圏になります。

視聴者数なら約500人です。

これはかなり大きいです。WebScreen側の現在の「最大20同時配信」という制限を考えても、初期段階ではVDS 2のCPUよりネットワークの方が先に問題になる可能性が高いです。WebScreen自体も映像を再エンコードせず、H.264 copy＋音声変換中心なので、これまでの実測でもCPUより出口帯域が先に制約になっています。

---

## ただし1000TBをVDS 2一台に買う意味はない

1Gbpsを30日間、一瞬も止めず100%使ったとしても、

**約324TB/月**

しか物理的に送れません。

70%運用なら、

**約227TB/月**

です。

したがって、

```
VDS 2 × 1台
＋ 1000TB Traffic
```

は完全に過剰です。

1000TBが意味を持つのは例えば、

```
VDS 2 × 5台
各1Gbps

Project Traffic
1000TB
```

のような水平スケール時です。

重要なのは、Traffic packageが**プロジェクト共通プール**なので、この構成と非常に相性がいいことです。

---

# つまりWebScreenのスケール戦略がかなりシンプルになる

私はこうします。

### 最初

```
Chicago Cloud VDS 2
€29/月
10TB Included
1Gbps
```

だけ契約。

追加トラフィックは買わない。

### 10TBに近づいたら

例えば80%で、

```
+10TB = €5
```

を追加。

20TBを超えそうなら、

```
+50TB = €25
```

などをStandalone Traffic packageとして購入。

価格は\*\*€0.50/TB\*\*です。公式も追加trafficを€0.5/TB/月からとしています。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/network/bandwidth-plans?utm_source=chatgpt.com)

今回の画面を見る限り、

-   契約時に10→20TB：+€5
    
-   後から10TB追加：+€5
    

なので、**先に20TBを買っておく経済的メリットもほぼありません。**

必要になってから買えばいいです。

---

## さらに使用量が増えたら

例えばピーク500人を超え始めたら、トラフィックを増やすのではなく**VDSを1台追加**します。

```
Chicago

VDS2-A  1Gbps
VDS2-B  1Gbps
VDS2-C  1Gbps

        ↓

Project traffic pool
200TB
```

この場合、

-   CPU：3倍
    
-   ピーク帯域：3Gbps
    
-   Included traffic：10TB×3 = 30TB
    
-   買ったTraffic package：全3台で共有
    

となります。

例えばAが150TB、Bが30TB、Cが10TB使っても、プロジェクト合計が許容量以下なら問題ありません。これはCherryが公式に想定しているモデルです。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/knowledge/docs/usage-billing/bandwidth-plans?utm_source=chatgpt.com)

---

# Performance VDSという別ルートもある

Cherryには**Performance VDS 2**もあり、こちらは、

-   4 vCore
    
-   16GB
    
-   Ryzen 7950X
    
-   **3Gbps uplink**
    
-   10TB Included
    

です。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/pricing/virtual-servers/c1-4-16gb-200nv-perf?currency=USD&utm_source=chatgpt.com)

これが面白い。

WebScreenはCPUよりネットワークを欲しがるので、

```
Cloud VDS 2
€29
1Gbps

↓

Performance VDS 2
約$104
3Gbps
```

という選択肢があります。

3Gbpsなら理論上月972TBまで流せるので、**Standalone 1000TB Traffic packageとほぼ釣り合います。**

ただ、コスト効率だけ考えるなら、Cloud VDS 2を複数台並べた方が安い可能性が高いです。

例えば現在のセール価格なら、

```
Cloud VDS 2 × 3
€87/月
計3Gbps
計12物理相当vCore?（3台）
48GB RAM
```

なので、Performance VDS 2一台よりむしろ安い。

WebScreenには水平分散の方が向いています。

---

# もう一つ制限がある：PPS

CherryのVDSには、サーバー1台あたり約**200,000 packets/sec**の自動PPS制限があります。[![](https://www.google.com/s2/favicons?domain=https://www.cherryservers.com&sz=128)Cherry Servers](https://www.cherryservers.com/legal/virtual-server-fair-usage-policy)

WebScreenの1.4Mbps程度のRTSP TCP配信なら、500人規模でいきなり200kppsへ達する可能性は高くありませんが、**1Gbpsだけ見て「無限にTCP connectionを増やせる」と考えるべきではありません。**

本番移行時には、

-   500 viewer
    
-   700 viewer
    
-   40人×10〜15 streams
    

の負荷試験をChicago実機でやるのがよいです。

---

# 最終的な答え

心配していた

> 「大量トラフィックを使いたいから、大きくて高価なサーバーを契約しなければならない」

というCherryの料金体系では**ありません**。

むしろ、

```
サーバーサイズ
↓
CPU・RAM・瞬間帯域で選ぶ

Traffic package
↓
月間転送量で独立して選ぶ
```

という設計です。

**Cloud VDS 2の20TBは「20TBしか流せない」という意味ではありません。**

現在確認できた範囲では、

**Cloud VDS 2 + Standalone Traffic package 最大1000TB/注文**

まで組み合わせられます。

その際もVDS 2の速度は1Gbpsのままなので、WebScreenの場合は**月間転送量ではなく「ピークが1Gbpsに近づいた時」が次のサーバーを増やすタイミング**になります。

これはWebScreenにかなり都合のいい料金体系です。

そして運用も、**10TB Includedの最小構成で始める → 使用量80%で追加Trafficを買う → ピーク帯域700Mbps程度でVDSを増やす**、でよさそうです。

さらにCherryはTraffic追加APIを公開しているので、将来的には**D1に使用量を記録して「残り20%になったら自動で+10TB/+50TB購入」まで自動化できる可能性があります。** これは無料WebScreenをコスト最小で回す仕組みとしてかなり相性がいいです。 [![](https://www.google.com/s2/favicons?domain=https://api.cherryservers.com&sz=128)Cherry Servers](https://api.cherryservers.com/doc/?utm_source=chatgpt.com)

ChatGPT の回答は必ずしも正しいとは限りません。重要な情報は確認するようにしてください。

  

極高