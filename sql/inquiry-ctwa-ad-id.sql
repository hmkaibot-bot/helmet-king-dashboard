-- 查詢與轉換:CTWA 廣告歸因欄
--
-- SleekFlow API 訊息原始 JSON 有成個 Meta CTWA referral
-- (extendedMessagePayload.extendedMessagePayloadDetail.whatsappCloudApiReferral),
-- 入面 source_id = 帶個客入嚟嗰個 ad 嘅 id — 即係每個查詢電話可以掛返實際邊個
-- 廣告 post,唔使再靠 webhook 個 boolean 標記估。
--
-- inquiry_events.ctwa_ad_id     — 呢條訊息係 CTWA 入口訊息嘅話,係邊個 ad(Meta ad id)
-- inquiry_conversions.ctwa_ad_ids — 呢個電話歷來經邊啲 ad 入過嚟(逗號串,同
--                                   inquired_product_ids 一樣格式)
--
-- 已於 2026-08-18 apply 咗上 production(additive,無需 backfill 先行)。

alter table inquiry_events add column if not exists ctwa_ad_id text;
alter table inquiry_conversions add column if not exists ctwa_ad_ids text;
