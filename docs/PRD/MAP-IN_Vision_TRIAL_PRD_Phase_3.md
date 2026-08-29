# MAP-IN Vision (TRIAL) — PRD Phase 3

**Internal architecture baseline:** V3.0  
**Product status:** TRIAL / BETA engineering validation  
**Primary Edge:** NVIDIA Jetson Xavier NX 8 GB / compatible Jetson  
**Development:** Laptop/PC-first  
**Runtime:** Offline-first

## 1. Product Vision
MAP-IN Vision is an offline-first industrial machine-vision platform inspired by familiar industrial vision workflows, with original UI/UX and architecture. It combines camera acquisition, Memory Image, Mastering, configurable inspection Tools, Level/Threshold Adjustment, AI/Vision inference, I/O mapping, Recipe control, Test/Adjust verification, and production Run.

### Non-negotiable principles
- No Internet is required for core runtime.
- Images, models, recipes, results and logs remain local by default.
- Hardware access is abstracted from UI/business logic.
- TEST and RUN are strictly separated.
- Production I/O must not be triggered by Memory/Test execution.
- Development is primarily on laptop/PC; Jetson is the final edge validation target.

## 2. Existing Web Application — Legacy/Reference
The repository already contains a working web-based MAP-IN prototype using browser technologies, GitHub Pages and Google Apps Script. This application is valuable reference material but is **not the architecture baseline for MAP-IN Vision Edge**.

### Policy
- Preserve the existing web application.
- Do not blindly merge or rewrite it into the Edge application.
- Treat existing web code as **Legacy / Reference / Candidate Reuse**.
- Reuse algorithms or UX concepts only after review and adaptation.
- Do not introduce Google Apps Script, cloud APIs, browser-only dependencies, or other online runtime dependencies into MAP-IN Vision Edge.

### Repository separation target
```text
mapin-vision-app/
├── legacy-web/              # existing web prototype; reference-only
├── mapin-edge/              # new Jetson/offline application
├── docs/
│   ├── PRD/
│   ├── architecture/
│   ├── screens/
│   └── development/
├── tests/
├── assets/
├── models/
└── CLAUDE.md
```

The exact migration structure may be adjusted after the Legacy Code Audit. Existing working files must not be moved/deleted until an explicit migration plan is approved.

## 3. Corrected End-to-End Workflow
**OPEN CAMERA → LIVE → CAPTURE → MEMORY IMAGE → MASTERING → ADD TOOLS → TOOL SETTING → LEVEL / THRESHOLD ADJUSTMENT → I/O SETTING → TEST ↔ ADJUST → SAVE / LOCK RECIPE → RUN**

TEST is an iterative verification loop. The engineer can return from TEST to Tool Setting or Level Adjustment, test again, and repeat until validation passes.

### State model
```text
CAMERA_OPEN
  → LIVE
  → CAPTURE
  → MEMORY
  → MASTER
  → TOOL_CONFIG
  → LEVEL_ADJUST
  → IO_CONFIG
  → TEST
  ↔ ADJUST
  → VALIDATE
  → SAVE/LOCK
  → RUN
```

## 4. Development & Deployment Strategy
Approximately 90–95% of software development should be performed on laptop/PC. Jetson validation covers ARM64 compatibility, CUDA/TensorRT, real camera, real PLC/Arduino, cycle time, RAM, GPU, temperature, storage and Genba behavior.

### Development mode
- Laptop/PC
- USB UVC webcam or simulator
- ONNX development inference
- PLC/I/O simulator
- SQLite/local storage
- Automated tests

### Edge mode
- Jetson Xavier NX 8 GB
- Real industrial/USB camera
- TensorRT optimized inference where supported
- Real PLC and/or Arduino Uno USB
- Local NVMe/storage
- Offline runtime

## 5. System Architecture
Layered architecture:

`UI → Application/Workflow → Inspection Engine → Hardware Abstraction → Adapters/Drivers`

Required interfaces:
- `ICamera`
- `IAIEngine`
- `IInspectionTool`
- `IIOController`
- `IPLCEngine`
- `IStorage`
- `IRecipeRepository`
- `IAuditLogger`

UI must not directly access camera SDKs, PLC drivers, Arduino USB code, or database internals.

## 6. Camera Requirements
Support:
1. Industrial GigE camera (Basler reference adapter)
2. Industrial USB camera
3. Standard USB UVC webcam
4. Camera simulator

Camera controls/workflow:
- OPEN CAMERA
- CLOSE CAMERA
- LIVE
- CAPTURE
- MEMORY IMAGE
- MASTERING
- TEST
- RUN

Camera metadata should be retained where available: camera ID, frame ID, timestamp, exposure, gain, resolution, trigger source.

## 7. Memory Image / Mastering
### Memory Image
- Capture and save local reference images.
- Browse/select images.
- Permission-controlled delete/import/export.
- Use Memory Images for Mastering and Test.

### Mastering
- Create/validate master reference.
- Associate master with Recipe/Tool/AI model versions.
- Maintain version and audit traceability.
- Support authorized replace/re-master workflow.

Mastering is not the complete inspection program. **Tools are added after Mastering.**

## 8. Inspection Tools
Workflow:

`ADD TOOL → SELECT TOOL → ROI/REGION → PARAMETERS → TEST → ADJUST → VALIDATE → ENABLE`

Possible tools:
- Pattern / Position
- Blob
- Edge
- Measurement
- Presence / Absence
- AI Identify / Classification / Defect / Count
- Future detection / segmentation

Each tool exposes PASS/FAIL plus relevant score, measurement and diagnostics.

## 9. Level / Threshold Adjustment
After Tools are added, engineers can tune levels/thresholds while viewing the image and result overlay.

Possible parameters:
- Lower/upper limits
- Score threshold
- Sensitivity
- Tolerance
- Minimum/maximum area
- Edge threshold
- AI confidence threshold
- Tool-specific equivalents

Adjustment loop:
`SET → TEST → OBSERVE → ADJUST → TEST`

Changes are traceable and explicitly saved to the active Recipe.

## 10. I/O Configuration
### Inputs
- Trigger
- Part Present
- Reset

### Outputs
- READY
- BUSY
- OK
- NG
- ERROR

### Interfaces
- PLC through industrial/local-network adapter.
- Arduino Uno via USB as a non-safety I/O controller for prototype/test/simple machine interfaces.
- I/O simulator for development.

Safety-rated E-stop, gate/interlock, light curtain and other safety functions remain independent of MAP-IN.

## 11. TEST / ADJUST / RUN Safety
TEST supports Live Camera and Memory Image sources.

**Mandatory rule:** Memory/Test execution must never unintentionally write production OK/NG outputs to PLC or production I/O.

Final sequence:
`Tool Test → Level Adjustment → Test Again → I/O Validation → Final Test → Save Recipe → Lock Recipe → RUN`

RUN requires a validated active Recipe. Engineering parameters are read-only in RUN unless an authorized unlock procedure is used.

## 12. Recipe
Recipe contains:
- Camera configuration
- Master reference/version
- Tool list/order
- ROI and tool parameters
- Levels/thresholds
- AI model/version
- Inspection logic
- I/O mapping
- Image retention policy
- Configuration version
- Audit information

Traceability:
`Recipe Version → Master Version → Tool Configuration → AI Model Version → Camera Configuration → Inspection Result → Evidence Image`

## 13. Offline / Data Security
- No Internet required for runtime.
- No cloud inference.
- No automatic image upload.
- No automatic dataset synchronization.
- No hidden external telemetry.
- Local storage for images, recipes, models, results, logs and audit records.
- Explicit, permission-controlled, auditable export only.
- Local PLC/MES communication may use Ethernet without Internet.
- UI should display OFFLINE / LOCAL state.

## 14. Jetson Resource Strategy
Jetson Xavier NX 8 GB is an inference/inspection target, not a heavy model-training workstation.

- Training on workstation.
- Prefer ONNX during development.
- Prefer TensorRT FP16 optimized inference on Jetson where supported.
- Monitor RAM, CPU, GPU, temperature, inference latency, FPS, disk and I/O latency.
- Normal RAM target <70%; investigate sustained >85%; >90% is a resource fault condition.

## 15. GUI Branding
Global header:

`[ MUSASHI ]    MAP-IN Vision (TRIAL)    [ GO FAR BEYOND ]`

Supplied logos are local UI assets and must not enter the inspection/evidence image area.

## 16. Screen Specification
| ID | Screen | Responsibility |
|---|---|---|
| SCR-001 | Login | Authentication/RBAC |
| SCR-002 | Home | Machine/inspection overview |
| SCR-020 | Camera Setup | Open/Close/Live/camera parameters |
| SCR-022 | Memory Image | Capture/browse/select/manage local images |
| SCR-023 | Mastering | Create/validate/replace master |
| SCR-030 | Tool Selection | Add/select/remove/reorder tools |
| SCR-031 | Tool Setting | ROI and tool parameters |
| SCR-032 | Level Adjustment | Threshold/level/sensitivity/tolerance |
| SCR-040 | I/O Configuration | PLC/Arduino mapping and test |
| SCR-050 | Test Inspection | Live/Memory test, per-tool and final result |
| SCR-060 | Recipe | Save/version/lock/unlock/activate |
| SCR-070 | Run | Production inspection and result |
| SCR-080 | History | Result/evidence/audit trail |
| SCR-090 | System/Health | Camera/AI/I/O/RAM/GPU/storage |

## 17. Functional Requirements — Updated
- FR-026: Support USB UVC webcam.
- FR-027: Camera abstraction for GigE, industrial USB, UVC webcam and simulator.
- FR-028: Core runtime works fully offline.
- FR-029: Store inspection data/images locally by default.
- FR-030: No automatic external transmission.
- FR-031: Local-network-only PLC/MES option.
- FR-032: Arduino Uno via USB.
- FR-033: Unified I/O abstraction.
- FR-034: OPEN/CLOSE CAMERA.
- FR-035: LIVE/CAPTURE/MEMORY IMAGE.
- FR-036: Mastering with traceable master version.
- FR-037: ADD TOOLS after Mastering.
- FR-038: Tool setting and ROI configuration.
- FR-039: Level/Threshold Adjustment with visual feedback.
- FR-040: I/O configuration before production RUN.
- FR-041: Iterative TEST ↔ ADJUST loop.
- FR-042: Block production PLC outputs in Memory/Test mode.
- FR-043: Require validated active Recipe before RUN.
- FR-044: Recipe locking and permission-controlled unlock.
- FR-045: Musashi/MAP-IN/Go Far Beyond branding.
- FR-046: Preserve legacy web prototype as reference; do not introduce its online runtime dependencies into Edge.
- FR-047: Legacy Code Audit must precede selective code/logic reuse.
- FR-048: Edge application must be independently runnable from the legacy web application.

## 18. Database Schema — Core Entities
Recommended local SQLite entities:
- users
- roles
- permissions
- projects
- recipes
- recipe_versions
- masters
- tools
- tool_parameters
- ai_models
- camera_profiles
- io_mappings
- inspections
- inspection_results
- inspection_images
- alarms
- audit_logs
- system_settings

Relationships must support full inspection traceability and recipe version locking.

## 19. API / Service Specification
Internal service boundaries should be local-process/module interfaces, not Internet APIs.

Suggested services/modules:
- CameraService
- ImageService
- MasterService
- ToolService
- InspectionService
- AIService
- IOService
- RecipeService
- HistoryService
- AuditService
- SystemHealthService

A local REST API may be introduced only if it materially benefits modularity/integration and does not create an Internet dependency.

## 20. AI Pipeline
Development:
`Image → Preprocess → ONNX Inference → Postprocess → Tool Result → Inspection Logic → Final Result`

Jetson:
`Image → Preprocess → TensorRT Inference → Postprocess → Tool Result → Inspection Logic → Final Result`

Training occurs off-device. Deploy only validated model artifacts. Model version is stored with Recipe and inspection result.

## 21. Error / Alarm Examples
| Code | Meaning |
|---|---|
| CAM-001 | Camera not found/connect failed |
| CAM-002 | Camera stream failed |
| IMG-001 | Invalid memory image |
| MST-001 | Master not validated |
| TOOL-001 | Tool configuration invalid |
| LVL-001 | Threshold/level invalid |
| IO-001 | I/O controller unavailable |
| IO-002 | I/O mapping invalid |
| TST-001 | Test output blocked (expected safety behavior) |
| RUN-001 | Recipe not validated/locked |
| AI-001 | AI model unavailable/incompatible |
| SYS-001 | High RAM usage |
| SYS-002 | Storage low |
| NET-001 | Unexpected external network state |

## 22. Acceptance Criteria — Critical Workflow
- AC-01: USB webcam can be opened, previewed, captured and closed.
- AC-02: Captured image appears in Memory Image manager.
- AC-03: Master can be created and linked to active Recipe.
- AC-04: Engineer can add at least one Tool after Mastering.
- AC-05: Tool ROI/parameters can be configured and tested.
- AC-06: Level/threshold can be adjusted with result feedback.
- AC-07: I/O can be mapped to PLC or Arduino test interface.
- AC-08: Memory/Test mode never writes production OK/NG.
- AC-09: Engineer can iterate TEST ↔ ADJUST.
- AC-10: Recipe can be saved/versioned/locked and activated.
- AC-11: RUN processes live images and produces final OK/NG according to tool logic.
- AC-12: Runtime works with Internet disconnected.
- AC-13: Evidence remains local unless explicitly exported.
- AC-14: Jetson benchmark documents RAM, GPU, temperature, latency and CT.
- AC-15: Legacy web application remains functional and is not broken by Edge development.
- AC-16: Edge runtime can be built/run without Google Apps Script or Internet services.

## 23. Claude Code Development Blueprint
Development order:
1. Legacy Code Audit / architecture inventory.
2. Repository separation plan and safe foundation.
3. Edge foundation: project structure, configuration, logging, SQLite, RBAC, test harness.
4. Camera/UVC + simulator.
5. Memory Image.
6. Mastering.
7. Tools.
8. Level Adjustment.
9. I/O simulator + Arduino USB + PLC adapter.
10. TEST ↔ ADJUST loop.
11. Recipe/version/lock.
12. RUN/History/Audit.
13. AI/ONNX development path.
14. Jetson/TensorRT/hardware validation.
15. Genba trial and release gate.

Every coding task must be mapped to an FR/SCR, limited in scope, tested, and reviewed before the next slice.

## 24. First Claude Code Tasks
### Task A — Legacy Audit (first)
Analyze the existing web application in this repository. Do not rewrite, move, delete, or merge it yet. Produce:
- architecture map
- feature inventory
- camera logic inventory
- vision tool inventory
- ROI/calibration inventory
- Arduino/PLC I/O inventory
- data/storage/API inventory
- reusable algorithms/components
- online dependencies
- technical debt
- migration candidates
- items that must be rewritten for Edge
- proposed safe repository separation

Stop after the audit report and wait for approval.

### Task B — Edge Foundation
After the audit is approved, create the Edge architecture and `mapin-edge` foundation. Do not implement the entire application in one task.

## 25. Definition of Done
TRIAL Genba readiness requires complete workflow validation, safe TEST/RUN separation, stable camera/I/O adapters, offline operation, recipe traceability, and documented Jetson performance/resource behavior.

Production release is a separate approval gate from TRIAL/BETA.
