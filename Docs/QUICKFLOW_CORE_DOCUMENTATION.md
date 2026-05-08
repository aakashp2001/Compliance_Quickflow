# Quickflow Core — Technical Documentation

## 1. Project Overview

Quickflow is an enterprise-grade digital form management and workflow automation platform built for regulated industries (pharmaceutical, manufacturing, QC labs). It replaces paper-based logbooks, batch records, and checklists with dynamic electronic forms that support configurable approval workflows, audit trails, e-signatures, and regulatory compliance (21 CFR Part 11). The system provides a drag-and-drop template designer, real-time form rendering with rule engines, multi-site/multi-schema tenant isolation, integrated reporting via Seal Report, RPA automation for lab instruments, and data connectors for external systems (REST, MQTT, OPC-UA, FTP, AMQP, etc.).

**Users:** Quality Assurance teams, production operators, lab analysts, site administrators, and IT administrators across multiple manufacturing/QC sites.

---

## 2. Tech Stack

| Category | Technology |
|----------|-----------|
| **Backend Framework** | ASP.NET Core 9.0 (C#), Clean Architecture |
| **Frontend Framework** | React 18 + Vite 6, TailwindCSS 4, Radix UI, MUI 5 |
| **API Gateway** | Custom gateway using YARP Reverse Proxy 2.3 |
| **Database** | Microsoft SQL Server (EF Core 9 + Dapper) |
| **Cache** | Redis (StackExchange.Redis) |
| **ORM** | Entity Framework Core 9 (migrations) + Dapper (stored procedures) |
| **CQRS** | MediatR 12 |
| **Auth** | JWT (HttpOnly cookies), Okta SSO, Face Auth, Active Directory/LDAP |
| **Real-time** | SignalR (NotificationHub, SealReportHub) |
| **Reporting** | Seal Report Library (.NET Core), ApexCharts, Grafana |
| **PDF Generation** | Winnovative HtmlToPdf, iText7, Playwright Chromium, jsPDF |
| **Document Editing** | OnlyOffice Document Server, CKEditor 5 |
| **State Management** | React Context API (AppContext), React Query (TanStack), useReducer hooks |
| **Forms** | React Hook Form + Zod/Yup validation, Formik |
| **Drag & Drop** | @dnd-kit/core, @dnd-kit/sortable |
| **Tables** | @tanstack/react-table |
| **Internationalization** | react-intl (i18n) |
| **PWA** | Workbox, vite-plugin-pwa, IndexedDB (idb), Service Workers |
| **Connector Protocols** | HTTP, GraphQL, SOAP, FTP, MQTT, AMQP, OPC-UA, RS-232, AWS S3, Azure ADLS |
| **Logging** | Serilog (console + async file sinks) |
| **Validation** | FluentValidation |
| **Security** | AES-256 encryption, RSA, rate limiting, CAPTCHA, Obfuscar obfuscation |
| **CI/CD** | Jenkins (Jenkinsfile, Jenkinsfile.pr, Jenkinsfile.release) |
| **Containerization** | Docker, Docker Compose |
| **Testing** | xUnit, Moq, FluentAssertions |
| **Code Quality** | Meziantou.Analyzer, SonarAnalyzer.CSharp, ESLint, Prettier |

---

## 3. Folder Structure

```
quickflow_core/
├── Quickflow.sln                          # Solution file
├── Directory.Build.props                  # Shared build properties
├── Directory.Packages.props               # Central NuGet package management
├── docker-compose.yml                     # Multi-container orchestration
├── Jenkinsfile                            # CI/CD pipeline
├── Deploy-Full.ps1 / deploy-full.sh       # Full deployment scripts
├── 1-Publish.ps1 / publish.sh             # .NET publish scripts
├── 2-Obfuscate.ps1                        # Production obfuscation
├── 3-Docker.ps1 / docker-deploy.sh        # Docker build scripts
│
├── Quickflow.Domain/                      # Domain layer (entities, DB scripts)
│   ├── Entities/                          # ~295 EF Core entity classes
│   │   ├── TblUserMst.cs                  # User master entity
│   │   ├── TblSheetMst.cs                 # Form sheet entity
│   │   ├── TblTemplateSheet.cs            # Template definition entity
│   │   ├── TblFormMst.cs / TblFormDtl.cs  # Form master/detail entities
│   │   ├── TblObjSectionEntry.cs          # Form field data entry
│   │   ├── Workflow.cs                    # Workflow configuration
│   │   ├── RpaMaster.cs                   # RPA automation master
│   │   ├── TblConnector*.cs               # Connector configuration entities
│   │   └── ...
│   └── db/                                # Raw SQL scripts
│       ├── procedures/                    # ~425 stored procedures
│       ├── functions/                     # SQL functions
│       ├── views/                         # SQL views
│       ├── triggers/                      # SQL triggers
│       ├── migrations/                    # Schema migrations
│       ├── seeds/                         # Seed data
│       └── tableTypes/                    # Table-valued parameters
│
├── Quickflow.Application/                 # Application layer (CQRS)
│   ├── DependencyInjection.cs             # MediatR registration
│   ├── Common/                            # Shared contracts & interfaces
│   └── Features/                          # Feature-organized handlers
│       ├── Auth/                          # Login, logout, token commands/queries
│       ├── TemplateDesigns/               # Template designer CQRS
│       ├── TemplateRender/                # Form rendering CQRS
│       ├── TemplateWorkflows/             # Workflow management
│       ├── Users/                         # User management
│       ├── Connectors/                    # Data connector logic
│       ├── Dashboard/                     # Dashboard queries
│       ├── EmailScheduler/                # Scheduled email logic
│       ├── OAuth2Server/                  # OAuth2 provider
│       └── ... (44 feature folders)
│
├── Quickflow.Infrastructure/              # Infrastructure layer
│   ├── DependencyInjection.cs             # Repository & service registration
│   ├── Data/                              # DbContext, schema-aware context
│   ├── Repositories/                      # ~40 repository implementations
│   │   ├── UsersRepository.cs             # User data access (70KB)
│   │   ├── TemplateRenderRepository.cs    # Form rendering queries (160KB)
│   │   ├── DashboardRepository.cs         # Dashboard data (79KB)
│   │   ├── RpaRepository.cs              # RPA data access (66KB)
│   │   ├── DocumentEditorRepository.cs    # Document management (62KB)
│   │   └── ...
│   ├── Services/                          # Business services
│   │   ├── AuthService.cs                 # Authentication logic
│   │   ├── UserContext.cs                 # Per-request user context
│   │   ├── PdfService.cs                  # PDF generation (57KB)
│   │   ├── SealReportService.cs           # Report engine (50KB)
│   │   ├── ExportService.cs               # Excel/PDF export
│   │   ├── OktaService.cs                 # Okta SSO integration
│   │   ├── Connectors/                    # Protocol handlers, factories
│   │   └── OAuth2Server/                  # OAuth2 token service
│   ├── Protocols/                         # Protocol handler implementations
│   ├── Triggers/                          # Event trigger handlers
│   ├── Migrations/                        # EF Core migrations
│   └── Utils/                             # Utilities
│
├── Quickflow.Shared/                      # Shared kernel
│   ├── Contracts/                         # Interfaces (Caching, Data, Logging, Services)
│   ├── Models/                            # DTOs (ApiResponse, UserDetail, etc.)
│   ├── Services/                          # RedisCacheService, LogService, etc.
│   ├── Utilities/                         # EncryptionUtility, ConfigurationUtility
│   └── Extensions/                        # Extension methods
│
├── Quickflow.WebApi/                      # Presentation layer (API)
│   ├── Program.cs                         # App startup, middleware pipeline
│   ├── Dockerfile.WebApi                  # Multi-stage Docker build
│   ├── Controllers/2025-07/               # 47 versioned API controllers
│   ├── Hubs/                              # SignalR hubs
│   │   ├── NotificationHub.cs             # Real-time notifications
│   │   └── SealReportHub.cs               # Report progress
│   ├── Middleware/                         # Request pipeline
│   │   ├── SchemaMiddleware.cs            # Multi-tenant schema routing
│   │   ├── GatewayUserMiddleware.cs       # User context from gateway
│   │   ├── RateLimitingMiddleware.cs      # API rate limiting
│   │   └── ApiVersioningMiddleware.cs     # Version routing
│   ├── Routes/                            # Minimal API routes
│   ├── Services/                          # WebApi-specific services
│   └── Filters/                           # Action filters
│
├── Quickflow.ApiGateway/                  # API Gateway (YARP)
│   ├── Program.cs                         # Gateway startup
│   ├── Dockerfile.ApiGateway              # Gateway Docker image
│   ├── Middleware/                         # Auth, maintenance, timing
│   ├── Services/                          # JWT, health checks, routing
│   └── appsettings.json                   # YARP route/cluster config
│
├── Quickflow.ReactClient/                 # Frontend SPA
│   ├── package.json                       # Dependencies
│   ├── vite.config.js                     # Vite build config
│   ├── Dockerfile.ReactClient             # Nginx-served production build
│   ├── nginx.conf                         # Nginx reverse proxy config
│   └── src/
│       ├── App.jsx                        # Root component, routing
│       ├── main.jsx                       # React entry point
│       ├── pages/                         # 45 page directories
│       ├── components/                    # 26 component directories + shared
│       ├── services/                      # 43 API service modules
│       ├── context/                       # AppContext, SocketContext
│       ├── hooks/                         # 21 custom hooks (useRoutes, etc.)
│       ├── providers/                     # Context providers
│       ├── i18n/                          # Internationalization
│       ├── utils/                         # Utilities, syncManager
│       ├── lib/                           # Storage helpers
│       └── styles/                        # CSS modules
│
├── Quickflow.Tests/                       # Unit/integration tests
├── Project.Documents/                     # Architecture docs
└── scripts/                               # Utility scripts
```

---

## 4. Database Schema

The database is **SQL Server** with multi-tenant schema isolation (each site gets its own schema). Key tables (prefix convention: `Tbl` for main tables, `Mst` for masters):

### Core User & Access Tables

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `TblUserMst` | `IUserId (int PK)`, `VLoginName`, `VLoginPass`, `VFirstName`, `VLastName`, `VEmailId`, `IUserTypeId (FK)`, `ILocationId (FK)`, `VActiveFlag`, `VAdflag`, `VIsLocked`, `DefaultApp` | User accounts |
| `TblUserDtl` | `IUserId (FK)`, additional profile fields | Extended user details |
| `TblUserTypeMst` | `IUserTypeId (int PK)`, type name, level | Roles / user types |
| `TblUserPassHistory` | `IUserId (FK)`, password hash, date | Password history for policy |
| `TblPasswordPolicyMst` | policy rules (min length, expiry days, complexity) | Password policy config |
| `TblDeptMst` | `IDeptId (PK)`, department name | Departments |
| `TblLocationMst` | `ILocationId (PK)`, location name, address | Sites/locations |
| `TblRoleOperationMatrix` | `IUserTypeId`, `IOperationId`, permissions | Role-based access matrix |
| `TblOperationMst` | `IOperationId (PK)`, operation name, parent | Menu operations |

### Template & Form Tables

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `TblTemplateSheet` | template ID, name, version, app ID, status | Template definitions |
| `TblsheetMst` | sheet ID (GUID), template ref, status, created by/date | Issued form instances |
| `TblSheetworkflowMst` | sheet ID, workflow stage, assigned user, status | Form workflow tracking |
| `Tblobjmst` | object ID, template ref, control definitions | Template UI objects/controls |
| `Tblobjsectionhdr` | section header ID, object ref | Section headers in forms |
| `Tblobjsectiondtl` | section detail ID, control properties, data type | Section detail (field defs) |
| `TblObjSectionEntry` | entry ID, sheet ID, object ID, value, row/col | Actual form data entries |
| `TblFormMst` | form master ID, name | Dynamic master form defs |
| `TblFormDtl` | form detail ID, column defs, data types | Dynamic master columns |
| `TblRuleHdr` / `TblRuleDtl` | rule ID, target control, conditions, actions | Business rules engine |

### Workflow Tables

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `Workflow` | workflow ID, name, stages JSON, template ref | Workflow definitions |
| `WorkflowHasUser` | workflow ID, user ID | Users assigned to workflow |
| `WorkflowHasUsertype` | workflow ID, usertype ID | Role-based workflow assignment |
| `ConditionWorkflow` | condition ID, expression, target workflow | Conditional workflow rules |
| `TblWorkflowMst` | master workflow definitions | Reusable workflow masters |

### Document & Reporting Tables

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `DocumentEditorEntry` | doc ID, file path, version, status, callbacks | OnlyOffice document tracking |
| `RptFolder` / `RptFile` | folder/file IDs, paths | Report file organization |
| `RptFileHasReports` | file-to-report mappings | Report associations |
| `QueryBuilder` | query ID, SQL, parameters, schedule | Custom query definitions |
| `GrafanaAnalyticDashboard` | dashboard ID, panels, data sources | Grafana dashboard config |

### RPA Tables

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `RpaMaster` | RPA ID, instrument, script type, schedule | RPA automation config |
| `RpaScriptData` | script ID, Python script content | Generated automation scripts |
| `RpaExecutionLog` | execution ID, status, timestamps, errors | RPA run history |
| `RpaInstrument` | instrument ID, name, connection params | Lab instrument definitions |
| `Mst089RpaMachineSettings` | machine ID, resolution, instrument mappings | Machine-level RPA config |

### Connector Tables

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `TblConnectorPlatforms` | platform ID, name, protocol type | External platform definitions |
| `TblConnectorCredentials` | credential ID, auth type, encrypted secrets | Authentication credentials |
| `TblConnector` | connector ID, platform ref, credential ref | Connector instances |
| `TblConnectorPullConfig` | pull config, schedule, field mappings | Inbound data pull config |
| `TblConnectorPushConfig` | push config, trigger, payload mapping | Outbound data push config |
| `TblConnectorPullLog` / `PushLog` | execution logs, status, record counts | Connector activity logs |

### OAuth2 Tables

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `TblOAuth2Client` | client ID, client secret, redirect URIs, scopes | OAuth2 client registration |
| `TblOAuth2AuthorizationCode` | code, client ref, user ref, expiry | Authorization code grants |
| `TblOAuth2Token` | token, refresh token, client/user refs | Issued tokens |

### Other Key Tables

| Table | Purpose |
|-------|---------|
| `Settings` / `QuickflowSetting` | Application configuration key-value pairs |
| `EmailTemplate` | Email notification templates |
| `EmailScheduler` / `EmailSchedulerLog` | Scheduled email automation |
| `AuditLog` | System-wide audit trail |
| `TblErrorLog` / `TblErrorLogCore` | Error logging |
| `ApplicationMaster` | Multi-app definitions |
| `AppHasSite` | App-to-site mapping |
| `InstrumentMaster` / `InstrumentTagMaster` | Lab instrument & tag config |
| `TblArchiveSheetMst` / `TblArchiveFormHistory` | Archived/completed forms |
| `CreateTaskSchedule` / `RunScheduleLog` | Scheduled task definitions & logs |
| `Favorites` / `UserFavoritePage` | User favorites/bookmarks |

### Relationships

- `TblUserMst.IUserTypeId` → `TblUserTypeMst.IUserTypeId`
- `TblUserMst.ILocationId` → `TblLocationMst.ILocationId`
- `TblsheetMst` → `TblTemplateSheet` (template reference)
- `TblSheetworkflowMst` → `TblsheetMst` (sheet workflow)
- `TblObjSectionEntry` → `TblsheetMst` + `Tblobjmst` (form data)
- `Tblobjsectiondtl` → `Tblobjsectionhdr` → `Tblobjmst` (template structure)
- `TblConnector` → `TblConnectorPlatforms` + `TblConnectorCredentials`
- `TblRoleOperationMatrix` → `TblUserTypeMst` + `TblOperationMst`

---

## 5. API Routes

All endpoints are versioned under `/api/2025-07/` (managed by `VersionedRouteConvention`). The API Gateway proxies `/api/{**catch-all}` → `http://webapi:80/`.

### Authentication (`AuthController`)
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/tokens` | Login (username/password, face auth, or RPA). Returns JWT in HttpOnly cookie. Body: `{Username, Password, LoginMode, CaptchaText, CaptchaId, FaceAuthToken, EndOtherSessions}` |
| `DELETE` | `/auth/token` | Logout. Invalidates session, clears Redis keys, sends SignalR logout. |
| `GET` | `/auth/configs` | Public. Returns app config (SSO type, version, captcha setting, Okta redirect URL). |
| `GET` | `/auth/me` | Returns authenticated user's ID from JWT claims. |
| `GET` | `/auth/me/status` | Checks if user is new or password expired. |
| `POST` | `/auth/verify` | Re-authenticates user (e-signature). Encrypted response. |
| `GET` | `/auth/token` | Returns current JWT token (for dashboard agent). |

### Users (`UsersController`)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/users` | List users with filters |
| `POST` | `/users` | Create user |
| `PUT` | `/users` | Update user |
| `GET/POST` | `/users/password` | Password management |
| `POST` | `/users/active-deactive` | Toggle user status |

### Template Design (`TemplateDesignsController`)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/template-designs` | List template sheets |
| `GET` | `/template-designs/{appId}` | Templates by app |
| `GET` | `/template-designs/objects` | Object section details |
| `POST` | `/template-designs/objects` | Create object master |
| `GET` | `/template-designs/rules` | Rule headers for controls |
| `POST` | `/template-designs/rules` | Create rule header |
| `GET` | `/template-designs/controls` | Controls for doc editor mapping |
| `GET` | `/template-designs/columns` | Master table columns |
| `GET` | `/template-designs/marginals` | Header/footer marginals |

### Template Render (`TemplateRenderController`)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/template-render/objects/masters` | Execute Proc_ObjMst (form data) |
| `POST` | `/template-render/masters` | Create sheet master (issue form) |
| `POST` | `/template-render/objects/entries` | Save form field data + trigger workflows |
| `GET` | `/template-render/audits` | Form audit trail |
| `POST` | `/template-render/workflows/validate` | Validate conditional workflows |
| `POST` | `/template-render/conversions/html-to-pdf` | HTML→PDF conversion |
| `POST` | `/template-render/conversions/word-to-html` | Word→HTML |
| `GET` | `/template-render/rules/{templateSheetId}` | Runtime rule headers |
| `POST` | `/template-render/emails/requests` | Send form emails |
| `GET` | `/template-render/templates/{id}/duplicates/validate` | Duplicate check |

### Template Workflows (`TemplateWorkflowsController`)
| Method | Path | Description |
|--------|------|-------------|
| `GET/POST/PUT/DELETE` | `/template-workflows/*` | CRUD for workflow definitions, stages, users |

### Dashboard (`LandingPageController`)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/landing-page/dashboard/*` | Dashboard widgets, my forms, schedule data |

### Masters (`MastersController`, `MasterDesignsController`)
| Method | Path | Description |
|--------|------|-------------|
| `GET/POST/PUT/DELETE` | `/masters/*` | Dynamic master table CRUD |
| `GET/POST` | `/master-designs/*` | Master table designer |

### Connectors (`ConnectorsController`)
| Method | Path | Description |
|--------|------|-------------|
| `GET/POST/PUT/DELETE` | `/connectors/*` | Connector CRUD, pull/push config, credentials, platforms |

### Reports (`SealReportController`, `ReportsController`)
| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/seal-reports/*` | Seal Report execution, viewer, result caching |
| `GET` | `/reports/*` | Dynamic report generation |

### Other Controllers
| Controller | Base Path | Key Operations |
|-----------|-----------|----------------|
| `RpaController` | `/rpa/*` | RPA master CRUD, script data, execution logs, instrument configs |
| `EmailSchedulersController` | `/email-schedulers/*` | Email schedule CRUD, conditions, execution |
| `EmailTemplatesController` | `/email-templates/*` | Email template management |
| `FormIssuanceController` | `/form-issuance/*` | Form issuance and recurring logs |
| `FormPrintsController` | `/form-prints/*` | Print form views |
| `FormUnlocksController` | `/form-unlocks/*` | Unlock submitted forms |
| `ArchivesController` | `/archives/*` | Form archival |
| `DocumentLibraryController` | `/document-library/*` | File management |
| `DocumentsController` | `/documents/*` | OnlyOffice document ops |
| `InstrumentTagsController` | `/instrument-tags/*` | Instrument tag master |
| `InstrumentsController` | `/instruments/*` | Instrument master |
| `GrafanaController` | `/grafana/*` | Analytical dashboards |
| `QueryBuilderController` | `/query-builder/*` | Custom query builder |
| `ConfigurationsController` | `/configurations/*` | System settings |
| `SitesController` | `/sites/*` | Site management |
| `RolesController` | `/roles/*` | Role management |
| `SystemAccessController` | `/system-access/*` | Access control matrix |
| `Oauth2ServerController` | `/oauth2-server/*` | OAuth2 token endpoint |
| `Oauth2ClientsController` | `/oauth2-clients/*` | OAuth2 client management |
| `BotsController` | `/bots/*` | Bot/automation config |
| `HealthController` | `/health` | Health check |
| `CaptchaController` | `/captcha/*` | CAPTCHA generation/validation |
| `ExportsController` | `/exports/*` | Data export (Excel/PDF) |
| `UploadsController` | `/uploads/*` | File upload/download |
| `TaskSchedulerController` | `/task-scheduler/*` | Scheduled task logs |
| `QRPrintController` | `/qr-print/*` | QR code print labels |
| `TemplateAuditController` | `/template-audit/*` | Template audit trails |

### SignalR Hubs
| Hub | Path | Events |
|-----|------|--------|
| `NotificationHub` | `/api/hub/notifications` | `Logout`, `Connected`, real-time form notifications |
| `SealReportHub` | `/api/hub/seal-report` | Report execution progress |

---

## 6. Frontend Pages and Components

### Pages (45 page modules in `src/pages/`)

| Route | Page Component | Description |
|-------|---------------|-------------|
| `/login` | `Login` | Authentication page (username/password, captcha, Okta SSO, face auth) |
| `/okta-callback` | `OktaCallback` | Okta SSO callback handler |
| `/Home` | `Dashboard` | Main dashboard with widgets, my forms, schedules |
| `/dashboard-agent` | `DashboardAgent` | AI-powered dashboard agent |
| `/template-agent` | `TemplateAgent` | AI template assistant |
| `/Settings` | `ConfigurationManager` | System configuration panel |
| `/User` | `UserMaster` | User management CRUD |
| `/User-Account` | `UserAccount` | Password change, profile |
| `/System-Access-Control` | `RoleOperation` | Role-operation access matrix |
| `/Report-Access-Control` | `ReportRoleOperation` | Report access matrix |
| `/Design-Template` | `TemplateDesign` | Drag-and-drop template designer |
| `/Form/:formId` | `TemplateRender` | Runtime form renderer |
| `/Issuance` | `FormIssuance` | Form issuance management |
| `/Form-Issuance` | `RecurringLogIssuance` | Recurring log issuance |
| `/On-Demand-Forms` | `FormIssuance (onDemandOnly)` | On-demand form issuance |
| `/Archive` | `FormArchive` | Form archival |
| `/Withdrawal` | `FormWithdrawal` | Form withdrawal |
| `/Unlock` | `UnlockSheet` | Unlock submitted forms |
| `/Email-Template` | `EmailTemplate` | Email template editor |
| `/Email-Scheduler` | `EmailScheduler` | Email scheduling |
| `/View-Print` | `ViewPrint` | Form view/print |
| `/QR-Print` | `QRViewPrint` | QR code label printing |
| `/Create-Master` | `CreateMaster` | Dynamic master table creator |
| `/Master-Workflow` | `MasterWorkflow` | Master data workflows |
| `/Template-Workflow` | `TemplateWorkflow` | Template workflow designer |
| `/Template-Design-Audit-Trail` | `TemplateDesignAuditTrail` | Design change history |
| `/Instrument` | `InstrumentMaster` | Instrument management |
| `/Instrument-Tag` | `InstrumentTagMaster` | Instrument tag management |
| `/Query-Builder` | `QueryBuilder` | SQL query builder |
| `/Create-Dashboard` | `CreateDashboard` | Custom dashboard builder |
| `/Create-Panel` | `CreatePanel` | Dashboard panel designer |
| `/Create-Bot` | `CreateBot` | Bot/automation designer |
| `/Reports` | `DynamicReport` | Dynamic report viewer |
| `/Audit-Trails` | `DynamicReport` | Audit trail reports |
| `/rule-editor` | `RuleEditor` | Business rule editor |
| `/functions-library` | `FunctionsLibrary` | Custom functions library |
| `/document-list` | `DocumentEditor` | Document management |
| `/File-Mangement-Service` | `FileManager` (wrapped in `SocketProvider`) | File management with real-time |
| `/Connectors` | `ConnectorPlatforms` | Connector platform management |
| `/Connector-Credentials` | `ConnectorCredentials` | Connector credentials |
| `/Connector-Dataflows` | `Connectors` | Connector dataflow config |
| `/Connector-Data` | `ConnectorData` | Connector data viewer |
| `/OAuth2-Clients` | `OAuth2Clients` | OAuth2 client management |
| `/Task-Scheduler-Logs` | `TaskSchedulerLogs` | Scheduled task logs |
| `/report/view` | `ReportView` | Full-viewport report display |
| `/PreviewFile` | `PreviewFile` | File preview |
| `/GenerateReport` | `GenerateReport` | Report generation |
| `*` | `NotFound` | 404 page |

### Key Components (`src/components/`)

- **Layout**: `MainLayout`, sidebar navigation, header, breadcrumbs, app switcher
- **TemplateDesign**: Drag-and-drop form designer with property panels, control palette
- **TemplateWorkflow**: Visual workflow stage builder with user assignment
- **WorkflowStepper**: Step-by-step workflow progress indicator
- **Dashboard**: Widget grid, charts (ApexCharts), form status cards
- **Master**: Dynamic CRUD grid for master data tables
- **MasterReviewOffCanvas**: Off-canvas panel for master data review/approval (74KB)
- **FaceAuth / RegisterFace**: Face authentication camera components
- **VoiceAssistant**: Voice command interface
- **FloatingActionMenu**: QR scanner + voice assistant FAB
- **OfflineIndicator**: PWA offline status banner
- **RuleEditor**: Visual rule condition builder
- **SkeletonLoader**: Page loading skeletons
- **guard/AuthGuard**: Route authentication guard

### State Management

- **`AppContext`** (`src/context/AppContext.jsx`): Global state — `userData`, `appConfig`, `widgets`, `dynamicDashboards`, `schemaInfo`, `isAuthenticated`. Provides `login()`, `logout()`, `refreshUserData()`, `refreshForAppSwitch()`.
- **`SocketContext`** (`src/context/SocketContext.jsx`): Socket.IO connection for file manager.
- **React Query** (`@tanstack/react-query`): Server state caching for API data.
- **`useReducer` hooks**: `roleOperationReducer.js`, `reportRoleOperationReducer.js` for complex matrix state.
- **Custom hooks**: `useRoutes` (dynamic route generation from menu), `useConfigurationManager`, `useIdleLockout`, `useOnlineStatus`, `useAppTabSync`.

---

## 7. Core Flows

### Flow 1: User Login → Dashboard

1. User opens `/login` → `Login` page renders with username/password fields, optional CAPTCHA
2. `Login` calls `AppContext.login()` → `POST /auth/tokens` with credentials
3. `AuthController.Login()` validates CAPTCHA (via `ValidateCaptchaCommand`), checks license, authenticates via `UsersRepository.AuthenticateUserAsync()`, manages concurrent sessions via Redis
4. JWT token issued → stored in HttpOnly cookie (`S_Token`) + Redis session cache
5. `AppContext.fetchData()` fires in parallel: `GET /layout/users/me`, `getAppConfig()`, `widgets()`, `myDashboard()`, `getSchemaInfo()`
6. `App.jsx` fetches menu data via `LayoutService.getMenuData()` → `useRoutes` generates authorized route elements
7. SignalR connects via `connectToSignalR(userId)` → joins `user:{userId}` group in `NotificationHub`
8. `Dashboard` page renders with widgets, form cards, schedule data from `DashboardRepository`

### Flow 2: Template Design → Publish

1. Admin navigates to `/Design-Template` → `TemplateDesign` loads template list via `GET /template-designs`
2. Admin selects/creates template → drag-and-drop designer loads controls (text, dropdown, date, table, etc.)
3. Each control saved via `POST /template-designs/objects` → `InsertObjectMasterCommand` → `TemplateDesignsRepository`
4. Rules configured via `POST /template-designs/rules` → `InsertRuleHeaderCommand` → stored in `TblRuleHdr`/`TblRuleDtl`
5. Workflow assigned via `/Template-Workflow` → stages, users, conditions saved to `Workflow`, `WorkflowHasUser` tables
6. Template published via `publishtemplate` stored procedure → version incremented, schema-wise objects synced via `Proc_SyncObjectsAcrossSchemas`
7. Published template appears in menu for assigned user types

### Flow 3: Form Issuance → Fill → Approve

1. Supervisor goes to `/Issuance` → `FormIssuance` lists available templates from `GetTemplateForIssuance` SP
2. Supervisor issues form → `POST /template-render/masters` → `InsertSheetMstCommand` → creates `TblsheetMst` record with GUID, sets status to `in_progress`
3. Operator navigates to `/Form/:formId` → `TemplateRender` loads form structure via `GET /template-render/objects/masters` (calls `Proc_ObjMst`)
4. Operator fills fields → each save calls `POST /template-render/objects/entries` → `InsertObjSectionEntryCommand` → `Insert_tblobjSectionEntry` SP → data stored in `TblObjSectionEntry`
5. Rules evaluated client-side (show/hide, auto-calculate, validation) based on `TblRuleHdr`/`TblRuleDtl`
6. Operator submits → workflow advances → `TblSheetworkflowMst` updated, next user notified via SignalR `NotificationHub`
7. Reviewer approves → conditional workflows checked via `CheckConditionalWorkflow` SP → if approved, `EventTriggerHandler.ProcessEventAsync()` fires connector events, RPA notifications sent
8. Form archived via `Insert_tblArchiveData` SP

### Flow 4: Connector Data Pull (External Integration)

1. Admin configures connector: platform (`TblConnectorPlatforms`), credentials (`TblConnectorCredentials`), pull config (`TblConnectorPullConfig`) with schedule, field mappings
2. `ConnectorSchedulerService` (hosted background service) polls schedule intervals
3. On trigger: `ConnectorPullService` resolves protocol handler via `PooledProtocolHandlerFactory` (HTTP, MQTT, OPC-UA, FTP, etc.)
4. Protocol handler fetches data → `FieldMappingEngine` transforms fields → `DynamicTableService` writes to dynamic SQL tables
5. `TableTriggerService` fires configured triggers → `ConnectorLogService` logs execution in `TblConnectorPullLog`
6. Real-time subscriptions (MQTT, AMQP) managed by `RealTimeSubscriptionService` singleton

### Flow 5: Report Generation (Seal Report)

1. User navigates to `/Reports` → selects report from `RptFolder`/`RptFile` hierarchy
2. Frontend opens report viewer → `GET /seal-reports/viewer` → `SealReportService` loads `.srex` report definition from `SealRepository`
3. Report executes SQL against current schema → data rendered by Seal Razor templates
4. Progress tracked via `SealReportHub` SignalR → results cached in session
5. PDF export available via `PdfExportService` using Playwright Chromium headless rendering
6. Report displayed in iframe or opened in new tab at `/report/view`

---

## 8. Deployment and Infrastructure

### Docker Architecture (docker-compose.yml)

Four services orchestrated with health checks and dependency ordering:

| Service | Image | Port | Depends On |
|---------|-------|------|-----------|
| `redis` | `redis:latest` | 6379 | — |
| `webapi` | `quickflow-webapi` | 8001→80 | redis (healthy) |
| `apigateway` | `quickflow-apigateway` | 8000→80 | redis + webapi (healthy) |
| `reactclient` | `quickflow-reactclient` | 3000→80 | apigateway (healthy) |

### Dockerfiles

- **`Dockerfile.WebApi`**: Multi-stage build. Stage 1: Playwright image (Ubuntu noble) for Chromium. Stage 2: .NET runtime-deps + native libs (libgdiplus, ICU, Chromium deps). Copies pre-published binaries. Runs as non-root `appuser`.
- **`Dockerfile.ApiGateway`**: Lightweight .NET runtime image for YARP proxy.
- **`Dockerfile.ReactClient`**: Node build stage → Nginx serving static files with `nginx.conf` reverse proxy rules.

### Deployment Pipeline

1. `1-Publish.ps1` / `publish.sh` — `dotnet publish` self-contained for `linux-x64`; `npm run build` for React
2. `2-Obfuscate.ps1` — Obfuscar code obfuscation (production only)
3. `3-Docker.ps1` / `docker-deploy.sh` — Docker image build + compose up
4. `Deploy-Full.ps1` / `deploy-full.sh` — Runs all three steps

### CI/CD

- **Jenkins**: `Jenkinsfile` (main), `Jenkinsfile.pr` (PRs), `Jenkinsfile.release` (releases)
- Security scanning: Trivy (`.trivyignore`), Gitleaks (`.gitleaks.toml`)

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `DB_CONNECTION_STRING` | SQL Server connection (overrides appsettings) |
| `ASPNETCORE_ENVIRONMENT` | Development / Production |
| `ASPNETCORE_URLS` | Hosting URLs |
| `REDIS_PASSWORD` | Redis auth password |
| `REDIS_HOST_PORT` | Redis exposed port |
| `APIGATEWAY_HOST_PORT` | Gateway exposed port |
| `WEBAPI_HOST_PORT` | WebApi exposed port |
| `REACTCLIENT_HOST_PORT` | React client exposed port |
| `DOCKER_BUILDKIT` | Enable BuildKit |
| `EncryptionKey` | AES-256 encryption key |
| `ClaimsEncryptionKey` | JWT claims encryption |
| `ResponseEncryptionKey` | API response encryption |
| `SchemaCredentials:Password` | Multi-schema DB password |

### Startup Sequence (WebApi `Program.cs`)

1. Configure Serilog logging
2. Ensure database exists (`EnsureDatabaseExistsAsync`)
3. Apply EF Core pending migrations
4. Run SQL release (`ReleaseDatabaseHelper`) — deploys stored procedures, functions, views, triggers, seeds
5. Load configuration from database (`ConfigurationUtility.GetSettingAsync`)
6. Register services, middleware, SignalR hubs
7. Configure CORS, static files, session, rate limiting

---

## 9. Key Business Logic

### Multi-Tenant Schema Isolation

`SchemaMiddleware` intercepts every request and sets `CurrentSchemaContext.CurrentSchema` based on the authenticated user's site. `SchemaAwareDbContext` dynamically switches the EF Core default schema at runtime using `SchemaModelCacheKeyFactory` for per-schema model caching. All stored procedures execute within the tenant schema, enabling complete data isolation between manufacturing sites sharing the same database.

### Dynamic Form Engine

The template system is a full low-code form builder. Templates define a tree: `TblTemplateSheet` → `Tblobjmst` (controls) → `Tblobjsectionhdr` (sections) → `Tblobjsectiondtl` (field definitions). At runtime, `Proc_ObjMst` (a 42KB stored procedure) recursively assembles the entire form structure with data, rules, and workflow state into a multi-table dataset. The frontend `TemplateRender` component hydrates this into an interactive form with client-side rule evaluation.

### Business Rules Engine

Rules (`TblRuleHdr` + `TblRuleDtl`) support: show/hide controls, auto-calculate values, cascading dropdowns, duplicate validation, mandatory conditional fields, and cross-field formulas. Rules are evaluated both client-side (immediate UX) and server-side (data integrity). The `Get_templaterulehdr` SP (16KB) loads the complete rule graph for a template.

### Workflow Engine with Conditional Branching

Workflows support multi-stage approval with configurable user/role assignment per stage. `CheckConditionalWorkflow` SP evaluates field values against conditions to determine the next workflow branch. Supports send-back, rejection, parallel approvals, and auto-notifications. `Insert_Workflow` SP (48KB) handles the complex state machine transitions.

### Connector Protocol Abstraction

The connector system uses a Strategy pattern: `IProtocolHandlerFactory` → `PooledProtocolHandlerFactory` resolves the correct handler (`HttpProtocolHandler`, `MqttProtocolHandler`, `OpcuaProtocolHandler`, `FtpProtocolHandler`, `AmqpProtocolHandler`, `Rs232ProtocolHandler`, `GraphQLProtocolHandler`, `SoapProtocolHandler`, `AdlsProtocolHandler`, `S3ProtocolHandler`). The `ProtocolConnectionPool` manages persistent connections for stateful protocols (MQTT, AMQP, OPC-UA). `FieldMappingEngine` handles JSON path mapping, data type conversion, and transformation between external and internal schemas.

### JWT Session Management with Redis

Authentication uses dual-layer token management: JWT access tokens in HttpOnly cookies + session state in Redis. `ConsolidatedJwtService` (singleton in ApiGateway) validates tokens against Redis on every request. Concurrent session detection prevents multi-device login unless explicitly overridden. SignalR `NotificationHub` pushes forced-logout events to other sessions.

### PDF Generation Pipeline

Three PDF engines are available depending on content: Winnovative HtmlToPdf (simple forms), Playwright Chromium headless (complex layouts with JS), and iText7 (programmatic PDFs). `PdfService` (57KB) orchestrates template-to-PDF conversion with header/footer injection, page numbering, watermarks, and digital signatures. `PdfPostProcessor` handles post-render cleanup.

### Automated SQL Release System

On every startup, `ReleaseDatabaseHelper` scans `Quickflow.Domain/db/` directories and deploys SQL objects in dependency order: pre-deployment scripts → table types → functions → views → stored procedures → triggers → seeds → post-deployment scripts. This enables zero-downtime schema evolution without manual DBA intervention. Version tracking via `get_current_database_version` / `update_database_version` SPs.

### PWA & Offline Support

The React client is a Progressive Web App with Workbox service workers (`sw-custom.js`). `syncManager` uses IndexedDB to queue form submissions when offline and syncs them on reconnection (`syncOnPageLoad`). `useOnlineStatus` hook provides real-time connectivity awareness. `useAppTabSync` synchronizes auth state across browser tabs.
