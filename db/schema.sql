-- ============================================================
-- 百工拾遗 · 非遗手作主题网站 数据库结构
-- PostgreSQL 13+
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- 传承人 ----------
CREATE TABLE IF NOT EXISTS inheritors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  title       text NOT NULL DEFAULT '',
  region      text NOT NULL DEFAULT '',
  bio         text NOT NULL DEFAULT '',
  portrait_url text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- 作品 ----------
CREATE TABLE IF NOT EXISTS works (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  title        text NOT NULL,
  subtitle     text NOT NULL DEFAULT '',
  summary      text NOT NULL DEFAULT '',
  story        text NOT NULL DEFAULT '',
  inheritor_id uuid NOT NULL REFERENCES inheritors(id),
  cover_url    text NOT NULL,
  published_version int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 作品素材版本（换图不覆盖历史；课程记录留存其引用）
CREATE TABLE IF NOT EXISTS work_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id      uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'cover' CHECK (kind IN ('cover','detail')),
  asset_url    text NOT NULL,
  note         text NOT NULL DEFAULT '',
  is_current   boolean NOT NULL DEFAULT true,
  replaced_by  uuid REFERENCES work_assets(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_assets_work ON work_assets(work_id);

-- ---------- 材料 ----------
CREATE TABLE IF NOT EXISTS materials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  origin      text NOT NULL DEFAULT '',
  unit        text NOT NULL DEFAULT '',
  image_url   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_materials (
  work_id     uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  usage_note  text NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, material_id)
);

-- ---------- 作品步骤：展示版本与教学版本分离存储 ----------
CREATE TABLE IF NOT EXISTS work_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id         uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  step_no         int NOT NULL,
  title           text NOT NULL,
  display_text    text NOT NULL DEFAULT '',   -- 公开叙述（技艺故事）
  teaching_text   text NOT NULL DEFAULT '',   -- 教学细节（报名后 + 教学授权）
  teaching_tip    text NOT NULL DEFAULT '',
  UNIQUE (work_id, step_no)
);

-- ---------- 内容授权（传承人授权用途分离） ----------
-- purpose: display=公开展示许可  teaching=教学使用许可
-- subject_type: work / material
CREATE TABLE IF NOT EXISTS licenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensor_id  uuid NOT NULL REFERENCES inheritors(id),
  subject_type text NOT NULL CHECK (subject_type IN ('work','material')),
  subject_id   uuid NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('display','teaching')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,                 -- NULL 表示长期
  withdrawn_at timestamptz,
  scope_note   text NOT NULL DEFAULT '',
  CHECK (subject_type='work' OR purpose='display')  -- 材料仅展示授权
);
CREATE INDEX IF NOT EXISTS idx_licenses_subject
  ON licenses(subject_type, subject_id, purpose);

-- ---------- 课程课次 ----------
CREATE TABLE IF NOT EXISTS courses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  title              text NOT NULL,
  work_id            uuid NOT NULL REFERENCES works(id),
  inheritor_id       uuid NOT NULL REFERENCES inheritors(id),
  description        text NOT NULL DEFAULT '',
  location           text NOT NULL DEFAULT '',
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  capacity           int NOT NULL CHECK (capacity >= 0),
  status             text NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','rescheduled','canceled')),
  schedule_version   int NOT NULL DEFAULT 1,
  original_starts_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_courses_starts ON courses(starts_at);

-- ---------- 报名订单（状态机：held → confirmed；余量 → waitlisted） ----------
CREATE TABLE IF NOT EXISTS bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id        uuid NOT NULL REFERENCES courses(id),
  student_name     text NOT NULL,
  student_contact  text NOT NULL,             -- 手机号/邮箱，用作跨浏览器识别
  status           text NOT NULL CHECK
                     (status IN ('held','confirmed','waitlisted','cancelled','expired')),
  hold_expires_at  timestamptz,
  idempotency_key  text NOT NULL UNIQUE,
  waitlist_seq     bigserial,
  course_snapshot  jsonb NOT NULL,            -- 报名时课次快照（标题/时间/版本）
  created_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  cancelled_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_bookings_course_status ON bookings(course_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_contact ON bookings(student_contact);
-- 同一学员同一课次只能有一笔活跃订单（跨浏览器重复报名拦截）
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_active
  ON bookings(course_id, student_contact)
  WHERE status IN ('held','confirmed','waitlisted');
-- 候补按排队号顺序晋升
CREATE INDEX IF NOT EXISTS idx_bookings_wait
  ON bookings(course_id, waitlist_seq)
  WHERE status = 'waitlisted';

CREATE TABLE IF NOT EXISTS booking_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type        text NOT NULL,                  -- held/confirmed/waitlisted/promoted/cancelled/expired/reschedule_notice
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_events ON booking_events(booking_id, created_at);

-- ---------- 发布版本留存 ----------
CREATE TABLE IF NOT EXISTS published_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL CHECK (entity_type IN ('work','course','site')),
  entity_id    uuid NOT NULL,
  version      int NOT NULL,
  snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_note  text NOT NULL DEFAULT '',
  published_by text NOT NULL DEFAULT 'system',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, version)
);
CREATE INDEX IF NOT EXISTS idx_published_entity ON published_versions(entity_type, entity_id, version);

-- ---------- 管理员操作审计 ----------
CREATE TABLE IF NOT EXISTS audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       text NOT NULL DEFAULT 'admin',
  action      text NOT NULL,
  target      text NOT NULL DEFAULT '',
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
