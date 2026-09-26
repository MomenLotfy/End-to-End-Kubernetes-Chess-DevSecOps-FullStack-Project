# 🗺️ خارطة طريق المشروع (مبسطة)

> ملف واحد يفهمك المشروع كله: إيه الموجود، وإيه الناقص، وتشتغل بإيه وبأي ترتيب.
> التفاصيل المطولة موجودة في `docs/` — ده ملخص العمليات فقط.

## 0. المشروع ده إيه؟

لعبة شطرنج Full-Stack (React + Node.js/Express/Socket.io + PostgreSQL) ومعاها شغل DevOps كامل:
تشغيل محلي بـ Docker Compose، وملفات Kubernetes/Helm، وTerraform لـ AWS/EKS، وCI على GitHub Actions، ومراقبة بـ Prometheus.

## 1. تشغيل سريع (محليًا)

```bash
cp .env.example .env        # ثم عدّل القيم (JWT_SECRET, DB_PASSWORD, ...)
docker compose up --build   # backend + frontend + postgres + migration
```

التفاصيل في `README.md`.

## 2. خريطة الريبو

| المسار | لازمته | الحالة |
|---|---|---|
| `Chess-Backend/` | باك إند Node 22 + اختبارات | ✅ شغال، اختباراته خضراء |
| `Chess-Frontend/` | فرونت React + اختبارات | ✅ شغال، اختباراته خضراء |
| `Database/` | ملفات SQL للهجرة (001 → 008) | ✅ ثابت، متضيفش عليه إلا للضرورة |
| `docker-compose.yml` | تشغيل محلي/سيرفر واحد | ✅ الطريقة الأساسية للتشغيل حاليًا |
| `deploy/helm/chess` | شارت Kubernetes للتطبيق | 🟡 موجود، محتاج يتجرب على كلاستر |
| `deploy/helm/chess-observability` | شارت المراقبة | 🟡 موجود، محتاج يتجرب على كلاستر |
| `terraform/` | بنية AWS (staging/prod) بموديولات | 🟡 كود موجود، **مطبقش فعليًا** — محتاج قرار قبل `apply` |
| `.github/workflows/` | CI الحالي (build/test/validate/release) | ✅ شغال |
| `monitoring/` | إعدادات Prometheus | 🟡 موجود، مرتبط بالشارت |
| `scripts/` | نسخ احتياطي/استعادة، تنصيب ArgoCD والمراقبة | ✅ مساعدات جاهزة |
| `docs/` | توثيق مطول (معمارية، أمان، runbooks، SLOs) | 📚 مرجع — مش مطلوب تقرأه كله |
| `e2e/`, `tests/` | اختبارات تكامل | 🟡 موجودة، شغّلها قبل أي نشر مهم |
| `Manifest-file/` | مانيفستات K8s قديمة | ⚠️ LEGACY — متستخدمهاش |
| `EKS-TF/` | تيرافورم قديم | ⚠️ LEGACY — متستخدموش |
| `Jenkins-Pipeline-Code/`, `Jenkins-Server-TF/` | Jenkins قديم | ⚠️ LEGACY — المعتمد حاليًا GitHub Actions |

## 3. إيه الموجود فعلًا (الحصيلة)

- [x] تطبيق كامل شغال محليًا (compose) + اختبارات Backend وFrontend
- [x] صور Docker لكل خدمة
- [x] GitHub Actions: بناء + اختبار + فحوصاتInfra + إصدارات + فحص أمني دوري
- [x] Helm charts للتطبيق والمراقبة + NetworkPolicies + probes
- [x] Terraform منظم (staging/production) بموديولات: شبكة، EKS، RDS، Redis، S3، صلاحيات
- [x] سكربتات عمليات: نسخ/استعادة قاعدة البيانات، تنصيب ArgoCD والمراقبة
- [x] توثيق أمني وrunbooks في `docs/` (مرجع عند الحاجة)

## 4. إيه الناقص — اشتغل بالترتيب ده

### المرحلة A — ثبّت الأساس (قبل أي سحابة)
- [ ] شغّل المشروع بـ compose من الصفر وتأكد كل حاجة خضراء
- [ ] شغّل اختبارات الباك والفرونت (`npx jest ...` / `CI=true npm test`)
- [ ] جرّب سكربت النسخ والاستعادة: `scripts/backup-postgres.sh` و`restore-postgres.sh`
- [ ] راجع `SECURITY.md` واتأكد إن مفيش أسرار حقيقية في الريبو

### المرحلة B — سيرفر واحد (أرخص طريق للإنتاج)
- [ ] جهّز سيرفر Linux + دومين + SMTP (المتطلبات في `README.md`)
- [ ] انشر بـ compose على السيرفر، وفعّل HTTPS (`scripts/provision-https.sh`)
- [ ] ظبط النسخ الاحتياطي الدوري لقاعدة البيانات (cron + السكربتات)

### المرحلة C — Kubernetes/Staging (لما تحتاجها فعلًا)
- [ ] راجع `terraform/environments/staging` وافهم التكلفة قبل أي `apply`
- [ ] طبّق staging فقط، ثم ركّب ArgoCD (`scripts/install-argocd.sh`)
- [ ] انشر شارت `chess` على staging واتأكد من الـ probes والـ logs
- [ ] ركّب المراقبة (`scripts/install-monitoring.sh`) واتأكد إن الداشبورد شغالة

### المرحلة D — أمان ومراقبة (DevSecOps/SRE)
- [ ] فعّل التنبيهات المهمة فقط (السقوط، المساحة، الأخطاء 5xx) — الباقي لاحقًا
- [ ] حدد SLO بسيط (مثال: توافر 99% شهريًا) وسجّله في `docs/slo/`
- [ ] راجع نتائج `security-scheduled.yml` دوريًا وعالج الحرجة فقط
- [ ] اكتب runbook واحد مختصر لكل حادثة تحصل (مش قبلها)

### المرحلة E — الإنتاج السحابي (آخر حاجة)
- [ ] لا تلمس `terraform/environments/production` إلا بعد استقرار staging
- [ ] الإنتاج = نفس خطوات staging + دومين حقيقي + نسخ احتياطي مجرب فعليًا

## 5. قرارات محتاج تاخدها (ومتستعجلش فيها)

1. **سيرفر واحد ولا Kubernetes؟** — لو الاستخدام صغير، المرحلة B كافية. Kubernetes تكلفة وتعقيد.
2. **Jenkins ولا GitHub Actions؟** — القرار المكتوب في الريبو: GitHub Actions هو المعتمد، وJenkins legacy. لو مرتاح لكده، تجاهل فولدرات Jenkins.
3. **أكتر من نسخة (replicas)؟** — حاليًا نسخة واحدة إجباريًا. التوسع الأفقي له شغل مخصوص (موجود على برانش جانبي — قسم 7) ومش مطلوب دلوقتي.
4. **تكاليف AWS** — راجع تقدير التكلفة قبل أي `terraform apply`. staging أولًا دائمًا.

## 6. أوامر سريعة

```bash
# اختبارات
cd Chess-Backend  && npx jest --config jest.unit.config.js
cd Chess-Frontend && CI=true npm test -- --watchAll=false

# فحوصات ثابتة (من جذر الريبو)
python3 scripts/wave7-static-checks.py
python3 scripts/terraform-static-checks.py

# نسخ احتياطي / استعادة
./scripts/backup-postgres.sh
./scripts/restore-postgres.sh <backup-file>
```

## 7. ملحوظة: شغل تجريبي على برانش جانبي

على البرانش `arena/01a0c5c2-end-to-end-kubernetes-chess-de` فيه شغل إضافي (Graceful Shutdown للباك إند — كوميت `2d5596c`)، **مش مدمج** في `main` ومش مرفوع. لو حابب تراجعه:

```bash
git log --oneline main..arena/01a0c5c2-end-to-end-kubernetes-chess-de
git diff main...arena/01a0c5c2-end-to-end-kubernetes-chess-de --stat
```

- عجبك → اعمل Pull Request وراجعه بهدوء.
- معجبكش → سيبه، مش مأثر على أي حاجة.

---

*آخر تحديث: 2026-09-26 — عدّل الملف ده كل ما تخلص مرحلة (علّم ✅ بدل ⬜).*
