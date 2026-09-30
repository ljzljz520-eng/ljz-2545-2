-- ============================================================
-- 非遗手作平台 · PostgreSQL schema
-- 核心约束：
--  1) 席位占补通过 sessions 行级锁串行化，杜绝超卖
--  2) (session_id, contact) 确认态唯一，杜绝同一人跨浏览器重复占座
--  3) 作品内容以“发布版本”快照固化，换图/撤回授权不影响历史版本与课程记录
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- 传承人 / 技艺 / 材料 ----------
CREATE TABLE IF NOT EXISTS inheritors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  title       text,
  region      text,
  bio         text,
  portrait_asset_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crafts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  tagline     text,
  region      text,
  story       text,
  cover_asset_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS craft_inheritors (
  craft_id      uuid NOT NULL REFERENCES crafts(id) ON DELETE CASCADE,
  inheritor_id  uuid NOT NULL REFERENCES inheritors(id) ON DELETE CASCADE,
  PRIMARY KEY (craft_id, inheritor_id)
);

CREATE TABLE IF NOT EXISTS materials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  craft_id    uuid NOT NULL REFERENCES crafts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  origin      text,
  usage       text,
  sort        int NOT NULL DEFAULT 0
);

-- ---------- 素材（图片等，不可变；换图=新增素材并指向新素材） ----------
CREATE TABLE IF NOT EXISTS assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url         text NOT NULL,
  alt         text,
  mime        text NOT NULL DEFAULT 'image/svg+xml',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- 作品 + 发布版本（快照不可变） ----------
CREATE TABLE IF NOT EXISTS works (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  craft_id    uuid NOT NULL REFERENCES crafts(id) ON DELETE CASCADE,
  inheritor_id uuid REFERENCES inheritors(id),
  slug        text UNIQUE NOT NULL,
  title       text NOT NULL,
  summary     text,
  draft_snapshot jsonb NOT NULL,           -- {cover_asset_id, steps:[...]}
  published_version_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id     uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  version_no  int NOT NULL,
  snapshot    jsonb NOT NULL,              -- 发布瞬间内容快照，永久不变
  note        text,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, version_no)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_published_version') THEN
    ALTER TABLE works
      ADD CONSTRAINT fk_published_version
      FOREIGN KEY (published_version_id) REFERENCES work_versions(id);
  END IF;
END $$;

-- ---------- 授权：展示用途 与 教学用途 分离 ----------
CREATE TABLE IF NOT EXISTS grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id     uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  scope       text NOT NULL CHECK (scope IN ('display','teaching')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  reason      text,                          -- 撤回/授予说明
  start_at    timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,                      -- NULL = 长期
  granted_by  text NOT NULL DEFAULT 'admin',
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_grants_work_scope ON grants(work_id, scope);

-- 授权审计流水（撤回只是新增事件 + 状态翻转，历史可追溯）
CREATE TABLE IF NOT EXISTS grant_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id    uuid NOT NULL REFERENCES grants(id),
  action      text NOT NULL CHECK (action IN ('grant','revoke')),
  reason      text,
  operator    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- 课次 ----------
CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  craft_id    uuid REFERENCES crafts(id),
  work_id     uuid REFERENCES works(id),
  title       text NOT NULL,
  location    text,
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  capacity    int NOT NULL CHECK (capacity >= 0),
  schedule_version int NOT NULL DEFAULT 1,   -- 改期次数
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- 临时占位（预约保留方案） ----------
CREATE TABLE IF NOT EXISTS holds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id),
  name        text NOT NULL,
  contact     text NOT NULL,
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','converted','expired','released')),
  source      text NOT NULL DEFAULT 'direct'
              CHECK (source IN ('direct','waitlist')),
  waitlist_entry_id uuid,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  converted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_holds_session_status ON holds(session_id, status);

-- ---------- 候补 ----------
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id),
  name        text NOT NULL,
  contact     text NOT NULL,
  status      text NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting','invited','converted','expired','cancelled')),
  priority    int NOT NULL DEFAULT 0,       -- 被减容量挤出的占位享优先
  hold_id     uuid REFERENCES holds(id),
  invited_at  timestamptz,
  invite_expires_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wait_session_status
  ON waitlist_entries(session_id, status, priority, created_at);
-- 同一联系人在同一课次至多保留一个开放候补位；确认/过期/取消的历史均保留。
-- 旧库若存在并发造成的重复开放记录，保留最高优先级/最早一条，其余安全归档。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='waitlist_entries') THEN
    UPDATE waitlist_entries AS w
       SET status='expired'
      FROM (
        SELECT id,
               row_number() OVER (
                 PARTITION BY session_id, contact
                 ORDER BY priority DESC, created_at ASC
               ) AS rn
          FROM waitlist_entries
         WHERE status IN ('waiting', 'invited')
      ) ranked
     WHERE w.id=ranked.id AND ranked.rn > 1;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_waitlist_open_contact
  ON waitlist_entries(session_id, contact)
  WHERE status IN ('waiting', 'invited');

-- ---------- 报名 / 订单（PG 持久化，永不因授权撤回而删除） ----------
CREATE TABLE IF NOT EXISTS enrollments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id     uuid REFERENCES holds(id),
  session_id  uuid NOT NULL REFERENCES sessions(id),
  work_id     uuid REFERENCES works(id),
  name        text NOT NULL,
  contact     text NOT NULL,
  status      text NOT NULL DEFAULT 'confirmed'
              CHECK (status IN ('confirmed','cancelled')),
  booked_start_at timestamptz NOT NULL,      -- 报名时刻的课表快照（改期对比用）
  booked_end_at   timestamptz NOT NULL,
  schedule_version_at_booking int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancel_reason text
);
-- 关键：同一课次同一联系人只能有一条有效报名 → 双浏览器也无法重复成功
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollment_active_contact
  ON enrollments(session_id, contact) WHERE status = 'confirmed';

-- ---------- 幂等请求记录（断网重试 / 重复提交） ----------
CREATE TABLE IF NOT EXISTS idempotent_requests (
  idempotency_key text PRIMARY KEY,
  route           text NOT NULL,
  body_hash       text NOT NULL,
  status          text NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('pending','completed')),
  status_code     int,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  replayed_count  int NOT NULL DEFAULT 0
);
-- 兼容旧库：进行中的幂等请求状态码允许为 NULL；补齐状态字段与完成时间。
ALTER TABLE IF EXISTS idempotent_requests ALTER COLUMN status_code DROP NOT NULL;
ALTER TABLE IF EXISTS idempotent_requests
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('pending','completed'));
ALTER TABLE IF EXISTS idempotent_requests ADD COLUMN IF NOT EXISTS finished_at timestamptz;
UPDATE idempotent_requests SET status='completed', finished_at=COALESCE(finished_at, now())
  WHERE status_code IS NOT NULL AND status <> 'completed';
-- 上次进程异常退出时，pending 行不会有人继续写结果；重启后允许新请求接管并覆盖。
UPDATE idempotent_requests SET status='pending', status_code=NULL, response_body='{}'::jsonb
  WHERE status='pending' AND status_code IS NULL;
