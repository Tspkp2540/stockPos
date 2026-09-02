# StockPOS Backend

Backend สำหรับระบบจัดการร้าน StockPOS สร้างด้วย Express, PostgreSQL และ Socket.IO รองรับการขายหน้าร้าน การตัดสต็อก การเงิน ผู้ใช้หลายสิทธิ์ และคูปอง

## ความสามารถของระบบ

- เข้าสู่ระบบและสมัครสมาชิก พร้อมรหัสผ่านแบบ bcrypt
- แยกสิทธิ์ `ADMIN`, `STAFF` และ `USER` ทุก API ตรวจสอบสิทธิ์ก่อนดำเนินการ
- สร้างออเดอร์ ตัดวัตถุดิบตามสูตร BOM คำนวณต้นทุน, GP, รายรับสุทธิ และกำไร
- จัดคิวออเดอร์รายวันแบบปลอดภัยจากเลขคิวซ้ำ
- อัปเดตสถานะออเดอร์แบบ `COOKING → READY → COMPLETED`, ยกเลิกออเดอร์ และคืนสต็อกเมื่อยกเลิก
- บันทึกชื่อเล่น/เบอร์โทรของผู้ซื้อแบบไม่บังคับ เพื่อค้นหาออเดอร์ได้
- หน้า public lookup ให้ลูกค้าหรือผู้ใช้ทั่วไปติดตามออเดอร์ทั้งหมด หรือกรองด้วยเบอร์โทร
- จัดการวัตถุดิบ, รับของเข้าสต็อก, เมนูสินค้า, สูตร BOM, ตัวเลือกเมนู (Modifier) และช่องทางขาย
- บันทึก/แก้ไข/ลบค่าใช้จ่าย และสรุปการเงินตามวันที่
- ส่วนลดหน้าร้านและคูปอง โดยเก็บยอดก่อนลด ยอดลดแต่ละประเภท และยอดสุทธิในออเดอร์
- รับชำระด้วยเงินสด, QR, โอน, บัตร หรืออื่น ๆ พร้อมยอดรับและเงินทอน
- เปิด/ปิดกะเงินสดแยกตามผู้ใช้งาน และคำนวณยอดคาดการณ์กับยอดต่างเมื่อปิดกะ
- จัดการผู้ขายและใบรับวัตถุดิบเข้า รองรับหลายรายการต่อใบ ปรับต้นทุนเฉลี่ย และเก็บประวัติการเคลื่อนไหวสต็อก
- สร้างใบสั่งซื้อวัตถุดิบ ติดตามสถานะร่าง/ส่งผู้ขาย/รับของแล้ว และรับของเข้าคลังตามใบสั่งซื้อได้
- สถานะเมนูพร้อมขายจากสูตร BOM และล็อตวัตถุดิบที่ยังไม่หมดอายุ พร้อมปิดขายชั่วคราวรายเมนูโดย Admin
- ส่งเหตุการณ์แบบ real-time ผ่าน Socket.IO ให้หน้า POS, คิว และศูนย์ปฏิบัติการอัปเดตทันที

## สิทธิ์การใช้งาน

| สิทธิ์ | การใช้งาน |
| --- | --- |
| `ADMIN` | จัดการทุกส่วน: สต็อก เมนู การเงิน รายการขาย ค่าใช้จ่าย คูปอง และออเดอร์ |
| `STAFF` | สร้างและดูแลการขาย/ออเดอร์ ตรวจคูปอง และอัปเดตสถานะออเดอร์ |
| `USER` | ดูข้อมูลและประวัติออเดอร์ของตนเอง |
| ผู้เยี่ยมชม | เปิด dashboard ตรวจสอบคิวออเดอร์ และกรองด้วยเบอร์โทรได้โดยไม่ต้องเข้าสู่ระบบ |

## ส่วนลดและคูปอง

เมื่อสร้างออเดอร์ ระบบจะคำนวณยอดจาก backend ภายใน transaction เดียวกับการตัดสต็อก เพื่อให้รายงานการเงินเชื่อถือได้

1. เก็บ `subtotal_amount` เป็นยอดก่อนลด
2. หัก `manual_discount_amount` สำหรับส่วนลดที่พนักงานกรอก
3. ตรวจคูปองจากยอดหลังหักส่วนลดหน้าร้าน
4. ตรวจสถานะคูปอง วันเริ่ม/หมดอายุ ยอดขั้นต่ำ จำนวนสิทธิ์ และส่วนลดสูงสุด
5. เก็บ `coupon_code`, `coupon_id`, `coupon_discount_amount` และ `discount_amount`
6. คำนวณ GP, รายรับสุทธิ และกำไรจากยอดหลังหักส่วนลด

ตาราง `coupons` รองรับส่วนลดแบบจำนวนเงิน (`AMOUNT`) และเปอร์เซ็นต์ (`PERCENT`) พร้อมยอดขั้นต่ำ, เพดานส่วนลด, ช่วงเวลา และจำนวนครั้งที่ใช้ได้

## ตัวเลือกเมนู (Modifier)

Admin กำหนดกลุ่มตัวเลือกแยกตามเมนูได้ เช่น ระดับหวาน, น้ำแข็ง, ขนาดแก้ว หรือท็อปปิง แต่ละกลุ่มตั้งจำนวนที่ต้องเลือก/เลือกได้สูงสุด และกำหนดส่วนเพิ่มหรือลดราคาได้ ระบบตรวจว่าตัวเลือกเป็นของเมนูนั้นจริงก่อนสร้างออเดอร์ แล้วบันทึกชื่อและราคาของตัวเลือกเป็นข้อมูล snapshot ใน `order_item_modifiers` เพื่อให้ตั๋วและประวัติออเดอร์ไม่เปลี่ยนตามการแก้ไขเมนูภายหลัง

## การชำระเงินและกะเงินสด

ออเดอร์ใหม่สร้างข้อมูลชำระเงินหนึ่งรายการใน `order_payments` โดยรองรับ `CASH`, `QR`, `TRANSFER`, `CARD` และ `OTHER` เงินสดต้องมีการเปิดกะของผู้ที่รับชำระก่อน ระบบผูกยอดขายเงินสดเข้ากะนั้นโดยอัตโนมัติและคำนวณเงินทอนจากยอดที่รับจริง

`cash_shifts` เก็บเงินทอนเริ่มกะ ยอดเงินสดที่ควรมี ยอดนับจริง และส่วนต่าง การยกเลิกออเดอร์จะเปลี่ยนการชำระเงินเป็น `VOIDED` เพื่อไม่ให้นับรวมตอนปิดกะ

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
   ```

3. รันสำหรับพัฒนา

   ```bash
   npm run dev
   ```

   หรือรัน production:

   ```bash
   npm start
   ```

เมื่อ server เริ่มทำงาน จะสร้าง/เพิ่มโครงสร้างตารางที่จำเป็นแบบไม่ทำลายข้อมูล ได้แก่ `users`, `expenses`, `coupons` และคอลัมน์เพิ่มเติมของ `orders` โดยอัตโนมัติ

สำหรับฐานข้อมูลที่ต้องจัดการ migration เอง ใช้ไฟล์ [database/20260901_add_order_discounts_and_coupons.sql](database/20260901_add_order_discounts_and_coupons.sql)

## API หลัก

ทุก endpoint ใต้ `/api` ที่ระบุว่าป้องกัน ต้องส่ง header:

```http
Authorization: Bearer <token>
```

| กลุ่ม | Endpoint หลัก | สิทธิ์ |
| --- | --- | --- |
| ตรวจสุขภาพ | `GET /health` | สาธารณะ |
| ยืนยันตัวตน | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` | สาธารณะ / เข้าสู่ระบบ |
| ติดตามออเดอร์ | `POST /api/public/orders/lookup` | สาธารณะ |
| ออเดอร์ | `GET/POST /api/orders`, `PUT /api/orders/:id`, `PUT /api/orders/:id/status`, `PUT /api/orders/:id/cancel`, `DELETE /api/orders/:id` | ตามสิทธิ์ |
| สต็อก | `GET/POST/PUT/DELETE /api/inventory`, `POST /api/inventory/restock` | Admin |
| เมนู/สูตร | `GET/POST/PUT/DELETE /api/products`, `PATCH /api/products/:id/availability` | Admin/Staff อ่าน, Admin จัดการ/ปิดขาย |
| การเงิน | `GET /api/financial-summary`, `GET/POST/PUT/DELETE /api/expenses` | Admin |
| คูปอง | `POST /api/coupons/validate`, `GET/POST /api/coupons` | Staff/Admin, Admin |
| กะเงินสด | `GET /api/shifts/current`, `POST /api/shifts/open`, `POST /api/shifts/:id/close`, `GET /api/shifts` | Admin/Staff, Admin |
| ผู้ขาย/รับของเข้า | `GET/POST/PUT /api/inventory/suppliers`, `GET/POST /api/inventory/receipts`, `GET /api/inventory/lots`, `GET /api/inventory/movements` | Admin |
| ใบสั่งซื้อ | `GET/POST /api/purchase-orders`, `PATCH /api/purchase-orders/:id/status`, `POST /api/purchase-orders/:id/receive` | Admin |
| ตรวจนับ/ของเสีย | `POST /api/inventory/adjustments` | Admin |
| ช่องทางขาย | `GET /api/channels` | Admin/Staff |

ตัวอย่างสร้างคูปองผ่าน SQL:

```sql
INSERT INTO coupons
  (code, discount_type, discount_value, min_order_amount, max_discount_amount, usage_limit)
VALUES
  ('WELCOME10', 'PERCENT', 10, 100, 50, 100);
```

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
