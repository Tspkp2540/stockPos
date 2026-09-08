# StockPOS Backend

Backend สำหรับระบบจัดการร้าน StockPOS สร้างด้วย Express, PostgreSQL และ Socket.IO รองรับการขายหน้าร้าน การตัดสต็อก การเงิน ผู้ใช้หลายสิทธิ์ และคูปอง

## ความสามารถของระบบ

- เข้าสู่ระบบและสมัครสมาชิก พร้อมรหัสผ่านแบบ bcrypt
- แยกสิทธิ์ `ADMIN`, `STAFF` และ `USER` ทุก API ตรวจสอบสิทธิ์ก่อนดำเนินการ
- สร้างออเดอร์ ตัดวัตถุดิบตามสูตร BOM คำนวณต้นทุน, GP, รายรับสุทธิ และกำไร
- จัดคิวออเดอร์รายวันแบบปลอดภัยจากเลขคิวซ้ำ
- ป้องกันการสร้างออเดอร์ซ้ำเมื่อ client retry ด้วย `Idempotency-Key` ต่อผู้ใช้งาน: request เดิมจะคืนออเดอร์เดิมและไม่ตัดสต็อก ใช้คูปอง ชำระเงิน หรือคิดแต้มซ้ำ
- อัปเดตสถานะออเดอร์แบบ `COOKING → READY → COMPLETED`, ยกเลิกออเดอร์ และคืนสต็อกเมื่อยกเลิก
- บันทึกชื่อเล่น/เบอร์โทรของผู้ซื้อแบบไม่บังคับ เพื่อค้นหาออเดอร์ได้
- หน้า public lookup ให้ลูกค้าหรือผู้ใช้ทั่วไปติดตามเฉพาะคิวออเดอร์ของวันปัจจุบัน หรือกรองด้วยเบอร์โทร
- จัดการวัตถุดิบ, รับของเข้าสต็อก, เมนูสินค้า, สูตร BOM, ตัวเลือกเมนู (Modifier) และช่องทางขายพร้อมค่าธรรมเนียม
- บันทึก/แก้ไข/ลบค่าใช้จ่าย สรุปการเงินตามวันที่ รายงานยอดขายแยกตามช่องทาง/วิธีชำระเงิน และรายงานเชิงธุรกิจตามช่วงเวลา: ยอดรายเมนู, ช่องทาง, ชั่วโมงขายดี, ส่วนลด, GP, ต้นทุน และกำไร
- ปิดยอดประจำวันแบบ audit snapshot: ต้องปิดกะเงินสดที่เปิดอยู่ก่อน จากนั้นระบบล็อกการเพิ่ม/แก้ไข/ลบออเดอร์และค่าใช้จ่ายของวันนั้น
- ส่วนลดหน้าร้านและคูปอง โดยเก็บยอดก่อนลด ยอดลดแต่ละประเภท และยอดสุทธิในออเดอร์
- ระบบสมาชิกผูกกับเบอร์โทร: Admin กำหนดการรับ/ใช้คะแนนและเพดานส่วนลดได้ พร้อมย้อนคะแนนอัตโนมัติเมื่อยกเลิกออเดอร์
- รับชำระด้วยเงินสด, QR, โอน, บัตร หรืออื่น ๆ พร้อมยอดรับและเงินทอน
- เปิด/ปิดกะเงินสดแยกตามผู้ใช้งาน และคำนวณยอดคาดการณ์กับยอดต่างเมื่อปิดกะ
- จัดการผู้ขายและใบรับวัตถุดิบเข้า รองรับหลายรายการต่อใบ ปรับต้นทุนเฉลี่ย และเก็บประวัติการเคลื่อนไหวสต็อก
- สร้างใบสั่งซื้อวัตถุดิบ ติดตามสถานะร่าง/ส่งผู้ขาย/รับของแล้ว และรับของเข้าคลังตามใบสั่งซื้อได้
- สถานะเมนูพร้อมขายจากสูตร BOM และล็อตวัตถุดิบที่ยังไม่หมดอายุ พร้อมปิดขายชั่วคราวรายเมนูโดย Admin
- ส่งเหตุการณ์แบบ real-time ผ่าน Socket.IO ให้หน้า POS, คิว และศูนย์ปฏิบัติการอัปเดตทันที
- `GET /api/health` ตรวจ API และ PostgreSQL สำหรับหน้าร้านและระบบ monitoring โดยส่ง `503` เมื่อฐานข้อมูลไม่พร้อม
- เก็บ `audit_logs` ของ API ที่มีการเพิ่ม/แก้ไข/ลบ พร้อมผู้ทำรายการ, สิทธิ์, เป้าหมาย, สถานะตอบกลับ และ payload ที่ปกปิดข้อมูลลับ
- Admin ส่งออก snapshot ข้อมูลธุรกิจผ่าน backup JSON, ดู audit log และบันทึกผล checklist ก่อนเปิดใช้งานจริงได้

## สิทธิ์การใช้งาน

| สิทธิ์ | การใช้งาน |
| --- | --- |
| `ADMIN` | จัดการทุกส่วน: สต็อก เมนู การเงิน รายการขาย ค่าใช้จ่าย คูปอง และออเดอร์ |
| `STAFF` | สร้างและดูแลการขาย/ออเดอร์ ตรวจคูปอง และอัปเดตสถานะออเดอร์ |
| `USER` | ดูข้อมูลและประวัติออเดอร์ของตนเอง |
| ผู้เยี่ยมชม | เปิด dashboard ตรวจสอบคิวออเดอร์ และกรองด้วยเบอร์โทรได้โดยไม่ต้องเข้าสู่ระบบ |

## ความพร้อมก่อนเปิดใช้จริงและข้อมูลสำรอง

Admin ใช้หน้า **พร้อมเปิดใช้จริง** ใน frontend เพื่อดาวน์โหลดข้อมูลสำรองธุรกิจ ตรวจการเปลี่ยนแปลงย้อนหลัง และบันทึกผลทดสอบสิทธิ์ `ADMIN`/`STAFF`/`USER`, การขายครบเส้นทาง และการพิมพ์

`GET /api/admin/backups/export` ส่งออก snapshot JSON ของข้อมูลธุรกิจ เช่น เมนู, สูตร, สต็อก/ล็อต, ผู้ขาย, ซื้อเข้า, ออเดอร์, การชำระเงิน, ส่วนลด, คูปอง, กะเงินสด และ audit log โดยตั้งใจไม่ส่งออก password hash ไฟล์นี้ควรเก็บในพื้นที่เข้ารหัส และไม่ทดแทนการทำ backup ระดับ PostgreSQL เช่น Railway snapshot หรือ `pg_dump`

ตาราง `audit_logs` จะบันทึก API แบบ `POST`, `PUT`, `PATCH` และ `DELETE` ที่มีผู้ใช้ยืนยันตัวตน พร้อมปกปิด `password`, token และข้อมูลลับอื่นก่อนบันทึก

## ส่วนลดและคูปอง

เมื่อสร้างออเดอร์ ระบบจะคำนวณยอดจาก backend ภายใน transaction เดียวกับการตัดสต็อก เพื่อให้รายงานการเงินเชื่อถือได้

1. เก็บ `subtotal_amount` เป็นยอดก่อนลด
2. หัก `manual_discount_amount` สำหรับส่วนลดที่พนักงานกรอก
3. ตรวจคูปองจากยอดหลังหักส่วนลดหน้าร้าน
4. ตรวจสถานะคูปอง วันเริ่ม/หมดอายุ ยอดขั้นต่ำ จำนวนสิทธิ์ และส่วนลดสูงสุด
5. เก็บ `coupon_code`, `coupon_id`, `coupon_discount_amount` และ `discount_amount`
6. คำนวณ GP, รายรับสุทธิ และกำไรจากยอดหลังหักส่วนลด

ตาราง `coupons` รองรับส่วนลดแบบจำนวนเงิน (`AMOUNT`) และเปอร์เซ็นต์ (`PERCENT`) พร้อมยอดขั้นต่ำ, เพดานส่วนลด, ช่วงเวลา และจำนวนครั้งที่ใช้ได้

## สมาชิกและแต้มสะสม

Admin ตั้งกติกาผ่านหน้า **ตั้งค่าคะแนนสะสม** ได้ ได้แก่ การเปิด/ปิดระบบ, รูปแบบการรับคะแนนตามยอดซื้อหรือจำนวนแก้ว, ยอดซื้อ/จำนวนแก้วที่ได้รับ 1 คะแนน, มูลค่าส่วนลดต่อ 1 คะแนน และสัดส่วนส่วนลดสูงสุดที่ใช้คะแนนได้ต่อคำสั่งซื้อ ค่าเริ่มต้นคือทุก 25 บาทได้รับ 1 คะแนน, 10 คะแนนลดได้ 1 บาท และลดได้ไม่เกิน 50% ของยอดหลังหักส่วนลดหน้าร้าน/คูปอง

Backend อ่านกติกาปัจจุบันใน transaction เดียวกับการสร้างออเดอร์ จึงไม่รับค่าอัตราคะแนนจากหน้าเว็บ พนักงานค้นหาคะแนนจากเบอร์โทรก่อนยืนยันออเดอร์ได้ หน้า User แสดงคะแนนคงเหลือและประวัติการรับ/ใช้คะแนน ระบบบันทึกทุกความเคลื่อนไหวไว้ใน `loyalty_transactions`; หากยกเลิกออเดอร์ ระบบคืนคะแนนที่ใช้และย้อนคะแนนที่เคยได้รับใน transaction เดียวกับการคืนสต็อก

## ตัวเลือกเมนู (Modifier)

Admin กำหนดกลุ่มตัวเลือกแยกตามเมนูได้ เช่น ระดับหวาน, น้ำแข็ง, ขนาดแก้ว หรือท็อปปิง แต่ละกลุ่มตั้งจำนวนที่ต้องเลือก/เลือกได้สูงสุด และกำหนดส่วนเพิ่มหรือลดราคาได้ ระบบตรวจว่าตัวเลือกเป็นของเมนูนั้นจริงก่อนสร้างออเดอร์ แล้วบันทึกชื่อและราคาของตัวเลือกเป็นข้อมูล snapshot ใน `order_item_modifiers` เพื่อให้ตั๋วและประวัติออเดอร์ไม่เปลี่ยนตามการแก้ไขเมนูภายหลัง

## การชำระเงินและกะเงินสด

ออเดอร์ใหม่สร้างข้อมูลชำระเงินหนึ่งรายการใน `order_payments` โดยรองรับ `CASH`, `QR`, `TRANSFER`, `CARD` และ `OTHER` เงินสดต้องมีการเปิดกะของผู้ที่รับชำระก่อน ระบบผูกยอดขายเงินสดเข้ากะนั้นโดยอัตโนมัติและคำนวณเงินทอนจากยอดที่รับจริง

`cash_shifts` เก็บเงินทอนเริ่มกะ ยอดเงินสดที่ควรมี ยอดนับจริง และส่วนต่าง รวมถึงผู้เปิด/ผู้ปิดกะเพื่อให้ Admin ตรวจสอบย้อนหลังได้ การยกเลิกออเดอร์จะเปลี่ยนการชำระเงินเป็น `VOIDED` เพื่อไม่ให้นับรวมตอนปิดกะ

## จอเตรียมสินค้าและใบเสร็จ

สถานะ `READY` ใช้ระบุว่ารายการทำเสร็จและรอลูกค้าหรือ rider มารับสินค้า API `PUT /api/orders/:id/status` รับเฉพาะ `COOKING`, `READY` และ `COMPLETED`; การยกเลิกต้องเรียก `PUT /api/orders/:id/cancel` เพื่อให้คืนสต็อกและทำให้ข้อมูลชำระเงินเป็น `VOIDED` อย่างถูกต้อง

## ผู้ขายและการรับวัตถุดิบเข้า

`suppliers` เก็บข้อมูลผู้ขาย ส่วน `stock_receipts` และ `stock_receipt_items` เก็บใบรับของ ต้นทุนจริง และรายการที่รับเข้า เมื่อสร้างใบรับผ่าน `POST /api/inventory/receipts` ระบบจะ lock วัตถุดิบ, เพิ่มจำนวนคงเหลือ, คำนวณต้นทุนเฉลี่ยถ่วงน้ำหนัก และสร้าง `inventory_movements` ประเภท `PURCHASE` ภายใน transaction เดียวกัน จึงตรวจสอบย้อนกลับได้ว่าของเข้ามาจากใครและต้นทุนเท่าใด

`purchase_orders` และ `purchase_order_items` เก็บแผนการสั่งซื้อแยกจากการรับของจริง สถานะเดินตาม `DRAFT → SENT → RECEIVED` หรือ `CANCELLED` เมื่อเรียก `POST /api/purchase-orders/:id/receive` ระบบจะสร้าง `stock_receipts` เชื่อมกับใบสั่งซื้อนั้น แล้วเพิ่มสต็อก สร้างล็อต และบันทึกการเคลื่อนไหวใน transaction เดียวกัน จึงรับของซ้ำจากใบเดิมไม่ได้

`inventory_lots` เก็บเลขล็อต วันรับเข้า วันหมดอายุ จำนวนเริ่มต้น และจำนวนคงเหลือของแต่ละล็อต ทุกการขายจะจัดสรรวัตถุดิบจากล็อตที่วันหมดอายุเร็วที่สุดก่อน (FEFO) ผ่าน `order_item_lot_allocations` และไม่ใช้ล็อตที่หมดอายุ การแก้ไขหรือลบออเดอร์ และการยกเลิก จะคืนปริมาณให้ล็อตเดิมเพื่อให้ยอดย้อนหลังถูกต้อง

`GET /api/products` คำนวณ `is_available`, `availability_reason` และ `available_quantity` ของทุกเมนูจากสูตร BOM และยอดรวมของล็อตที่ยังไม่หมดอายุ เมนูที่วัตถุดิบไม่เพียงพอจะขายไม่ได้จาก POS หากทำได้เหลือ 1–5 แก้ว ระบบส่ง `is_low_stock` เพื่อแจ้งเตือนเมนูใกล้หมด (ปรับเกณฑ์ได้ด้วย `MENU_LOW_STOCK_THRESHOLD`) ส่วน Admin สามารถเรียก `PATCH /api/products/:id/availability` ด้วย `{ "is_sold_out": true }` เพื่อปิดขายชั่วคราว หรือส่ง `false` เพื่อเปิดให้ระบบคำนวณสถานะตามสต็อกอีกครั้ง การสร้างออเดอร์ตรวจสถานะปิดขายซ้ำใน backend เพื่อป้องกันการข้ามหน้าจอ POS

`POST /api/inventory/adjustments` ใช้สำหรับตรวจนับยอดจริง (`STOCK_COUNT`) หรือบันทึกของเสีย (`WASTE`) โดยบันทึกส่วนต่างเป็น `inventory_movements` ประเภท `ADJUSTMENT` ยอดคงเหลือจะไม่สามารถติดลบ และของเสียต้องระบุเหตุผลก่อนบันทึก

## การติดตั้งและรัน

1. ติดตั้งแพ็กเกจ

   ```bash
   npm install
   ```

2. สร้างไฟล์ `.env` จาก `.env.example` แล้วกำหนดค่าอย่างน้อย:

   ```env
   DATABASE_URL=postgres://username:password@hostname:5432/database_name
   AUTH_SECRET=replace_with_a_long_random_secret
   PORT=8080
   FRONTEND_ORIGINS=https://your-frontend.example.com
   ```

3. รันสำหรับพัฒนา

   ```bash
   npm run dev
   ```

   หรือรัน production:

   ```bash
   npm start
   ```

เมื่อ server เริ่มทำงาน จะสร้าง/เพิ่มโครงสร้างตารางที่จำเป็นแบบไม่ทำลายข้อมูล ได้แก่ `users`, `expenses`, `coupons`, `loyalty_settings`, `loyalty_accounts`, `loyalty_transactions` และคอลัมน์เพิ่มเติมของ `orders` โดยอัตโนมัติ

สำหรับฐานข้อมูลที่ต้องจัดการ migration เอง ใช้ไฟล์ [database/20260901_add_order_discounts_and_coupons.sql](database/20260901_add_order_discounts_and_coupons.sql), [database/20260908_add_order_idempotency.sql](database/20260908_add_order_idempotency.sql) และ [database/20260908_add_loyalty_settings.sql](database/20260908_add_loyalty_settings.sql)

## API หลัก

ทุก endpoint ใต้ `/api` ที่ระบุว่าป้องกัน ต้องส่ง header:

```http
Authorization: Bearer <token>
```

| กลุ่ม | Endpoint หลัก | สิทธิ์ |
| --- | --- | --- |
| ตรวจสุขภาพ | `GET /api/health` | สาธารณะ |
| ความพร้อมระบบ | `GET /api/admin/go-live/readiness`, `GET/PUT /api/admin/go-live-checks/:key` | Admin |
| สำรองข้อมูล/ประวัติแก้ไข | `GET /api/admin/backups/export`, `GET /api/admin/audit-logs` | Admin |
| ยืนยันตัวตน | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` | สาธารณะ / เข้าสู่ระบบ |
| ติดตามออเดอร์ | `POST /api/public/orders/lookup` | สาธารณะ |
| ออเดอร์ | `GET/POST /api/orders`, `PUT /api/orders/:id`, `PUT /api/orders/:id/status`, `PUT /api/orders/:id/cancel`, `DELETE /api/orders/:id` | ตามสิทธิ์ |
| สต็อก | `GET/POST/PUT/DELETE /api/inventory`, `POST /api/inventory/restock` | Admin |
| เมนู/สูตร | `GET/POST/PUT/DELETE /api/products`, `PATCH /api/products/:id/availability` | Admin/Staff อ่าน, Admin จัดการ/ปิดขาย |
| ช่องทางขาย | `GET/POST /api/channels`, `PUT /api/channels/:id` | Admin/Staff อ่าน, Admin จัดการ |
| การเงิน | `GET /api/financial-summary`, `GET /api/sales-breakdown`, `GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`, `GET/POST /api/daily-closings`, `GET/POST/PUT/DELETE /api/expenses` | Admin |
| คูปอง | `POST /api/coupons/validate`, `GET/POST/PUT /api/coupons` | Staff/Admin, Admin |
| สมาชิก/คะแนนสะสม | `GET/PUT /api/loyalty/settings`, `POST /api/loyalty/lookup`, `GET /api/loyalty/me` | Admin ตั้งค่า, Staff/Admin ค้นหา, User ดูของตน |
| กะเงินสด | `GET /api/shifts/current`, `POST /api/shifts/open`, `POST /api/shifts/:id/close`, `GET /api/shifts` | Admin/Staff, Admin |
| ผู้ขาย/รับของเข้า | `GET/POST/PUT /api/inventory/suppliers`, `GET/POST /api/inventory/receipts`, `GET /api/inventory/lots`, `GET /api/inventory/movements` | Admin |
| ใบสั่งซื้อ | `GET/POST /api/purchase-orders`, `PATCH /api/purchase-orders/:id/status`, `POST /api/purchase-orders/:id/receive` | Admin |
| ตรวจนับ/ของเสีย | `POST /api/inventory/adjustments` | Admin |

ตัวอย่างสร้างคูปองผ่าน SQL:

```sql
INSERT INTO coupons
  (code, discount_type, discount_value, min_order_amount, max_discount_amount, usage_limit)
VALUES
  ('WELCOME10', 'PERCENT', 10, 100, 50, 100);
```

Frontend จะแนบ `Idempotency-Key` ที่มีความยาว 8–120 ตัวอักษร (หรือ `client_request_id` ใน body) ทุกครั้งที่สร้างออเดอร์ และต้องใช้คีย์เดิมเมื่อ retry คำขอเดิม Backend ยังรองรับ client รุ่นเก่าที่ไม่ส่งคีย์ เพื่อให้การ deploy ไม่ทำให้หน้าร้านหยุดทำงาน แต่ client นั้นจะไม่ได้รับการป้องกันการส่งซ้ำ

## API security

กำหนด `FRONTEND_ORIGINS` เป็นโดเมน frontend ที่อนุญาต (หลายโดเมนคั่นด้วย comma) เพื่อจำกัดทั้ง REST API และ Socket.IO เช่น `https://stockpos.example.com,https://stockpos-staging.example.com` ระบบมี production frontend ของ StockPOS และ origin สำหรับพัฒนาในเครื่องใน allowlist เริ่มต้น แต่ต้องกำหนดตัวแปรนี้ก่อนเพิ่มโดเมน frontend อื่น ส่วน health check หรือ API-to-API request ที่ไม่มี `Origin` ยังทำงานได้

ระบบจำกัดจำนวนคำขอต่อ IP/ผู้ใช้ในหน่วยความจำ: ทุก `/api` สูงสุด 360 ครั้ง/นาที, login 12 ครั้ง/15 นาที, สมัครสมาชิก 5 ครั้ง/ชั่วโมง, public order lookup 30 ครั้ง/นาที และตรวจคูปอง/แต้ม 90 ครั้ง/นาทีต่อผู้ใช้ เมื่อเกินจะตอบ `429` พร้อม `Retry-After` และรหัส `RATE_LIMITED`

## Real-time events

Client เชื่อมต่อ Socket.IO โดยส่ง token ใน `auth.token` ผู้ใช้ทั่วไปจะอยู่ใน room ของตนเอง ส่วน Admin/Staff จะอยู่ใน room `operations` สำหรับรับออเดอร์ใหม่ การเปลี่ยนสถานะ และการยกเลิกออเดอร์

## โครงสร้างสำคัญ

```text
app/server.js       API หลัก, migration เริ่มต้นระบบ และ Socket.IO
middleware/auth.js  รหัสผ่าน, token และ role guard
router/             routes สำหรับสินค้า สต็อก และการยกเลิกออเดอร์
config/db.js        PostgreSQL connection pool
database/           SQL migrations สำหรับรันด้วยตนเอง
```
