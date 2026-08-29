# MAP-IN Vision (TRIAL) — Claude Code Project Rules

## 1. Product Identity
- Product: MAP-IN Vision (TRIAL)
- Internal architecture baseline: V3.0
- Target: offline-first industrial machine vision.
- Primary edge target: NVIDIA Jetson Xavier NX 8 GB / compatible Jetson platform.
- Development is laptop/PC-first; Jetson is the deployment and hardware-validation target.

## 2. Core Workflow — MUST NOT be changed without approval
OPEN CAMERA → LIVE → CAPTURE → MEMORY IMAGE → MASTERING → ADD TOOLS → TOOL SETTING → LEVEL / THRESHOLD ADJUSTMENT → I/O SETTING → TEST ↔ ADJUST → SAVE / LOCK RECIPE → RUN

TEST is an iterative verification loop. Engineers may move from TEST back to Tool Setting or Level Adjustment and test again.

## 3. Non-Negotiable Architecture Rules
1. Use layered architecture: UI → Application/Workflow → Inspection Engine → Hardware Abstraction → Adapters/Drivers.
2. UI must not directly access camera SDKs, PLC drivers, Arduino USB code, or database internals.
3. Camera access goes through `ICamera` and camera adapters.
4. AI access goes through `IAIEngine`.
5. Inspection tools use `IInspectionTool`.
6. I/O access goes through `IIOController`.
7. PLC access goes through `IPLCEngine` / PLC adapter.
8. Storage goes through `IStorage` / repository interfaces.
9. Keep hardware-specific code isolated from business logic.
10. Do not introduce cloud or Internet dependencies into the MAP-IN runtime.

## 4. Camera Requirements
Support:
- Industrial GigE camera (Basler reference adapter)
- Industrial USB camera
- USB UVC webcam
- Camera simulator for development

Camera workflow must support:
- OPEN CAMERA
- CLOSE CAMERA
- LIVE
- CAPTURE
- MEMORY IMAGE
- MASTERING
- TEST
- RUN

## 5. Memory / Mastering / Test Safety
- Memory images are stored locally by default.
- Master records must be traceable to recipe/tool/model versions.
- TEST can use Live Camera or Memory Image.
- TEST/MEMORY mode MUST NOT write production OK/NG outputs to PLC or production I/O.
- Production RUN requires a validated active recipe.
- Recipe configuration is locked in RUN unless an authorized engineering unlock procedure is used.

## 6. Inspection Tool Rules
Tools are added AFTER Mastering.
Expected sequence:
ADD TOOL → SELECT TOOL → ROI/REGION → PARAMETERS → TEST → ADJUST → VALIDATE → ENABLE

Possible tools include:
- Pattern / Position
- Blob
- Edge
- Measurement
- Presence / Absence
- AI Identify / Classification / Defect / Count
- Future detection / segmentation

Tool results must expose PASS/FAIL and relevant score/measurement/diagnostic data.

## 7. Level / Threshold Adjustment
- Tool parameters and thresholds must be editable in Engineering mode.
- Result overlays should update during testing where practical.
- Typical parameters: lower/upper limits, score threshold, sensitivity, tolerance, min/max area, edge threshold, AI confidence, or tool-specific equivalents.
- Changes must be traceable and explicitly saved to the active recipe.

## 8. I/O
Support:
- PLC through an industrial/local-network adapter.
- Arduino Uno via USB as a non-safety I/O controller for prototype/test/simple machine interfaces.
- I/O simulator for development.

Typical signals:
INPUT: Trigger, Part Present, Reset.
OUTPUT: READY, BUSY, OK, NG, ERROR.

Safety-rated E-stop, gate/interlock, light curtain, and other safety functions remain independent of MAP-IN.

## 9. Offline / Data Security
- Core runtime must operate with Internet disconnected.
- No cloud inference.
- No automatic image upload.
- No automatic dataset synchronization.
- No hidden external telemetry.
- Images, recipes, models, results, logs, and audit records remain local by default.
- Export must be explicit, permission-controlled, and auditable.
- Local PLC/MES communication may be used without Internet.

## 10. Jetson Resource Rules
- Xavier NX 8 GB is a production inference/inspection target, not a heavy training workstation.
- Model training happens on development PC/workstation.
- Prefer ONNX for development and TensorRT FP16 optimized inference on Jetson where supported.
- Monitor RAM, CPU, GPU, temperature, inference latency, camera FPS, disk usage, and I/O latency.
- Target normal RAM <70%; investigate sustained >85%; treat >90% as a resource fault condition.

## 11. Development Strategy
- Develop approximately 90–95% of software on laptop/PC.
- Validate Jetson-specific CUDA/TensorRT, real cameras, real PLC/Arduino, performance, thermal behavior, and Genba operation on Jetson.
- Use small vertical slices mapped to FR/SCR requirements.
- Do not attempt to implement the whole application in one task.

## 12. Claude Code Working Rules
1. Read PRD and this file before coding.
2. Before feature implementation, propose architecture/plan when requested.
3. Implement one bounded FR/SCR or small vertical slice at a time.
4. Do not modify unrelated files.
5. Do not perform broad refactors unless explicitly requested.
6. Add/update tests for every feature where testable.
7. Run relevant tests before declaring a task complete.
8. Report changed files, tests run, failures, and remaining risks.
9. Never silently change the approved workflow.
10. Never remove a working feature without explicit approval.
11. Prefer clear, maintainable code over clever abstractions.
12. Keep dependencies minimal and pinned where practical.
13. Never add Internet/cloud runtime dependency.
14. Treat production I/O as safety-sensitive; default to fail-safe behavior.
15. Keep Git commits small and logically scoped.

## 13. Branding
Global UI header:
[MUSASHI]    MAP-IN Vision (TRIAL)    [GO FAR BEYOND]

Brand assets are local UI assets and must not enter the camera inspection/evidence image area.

## 14. First Implementation Priority
Foundation → Camera/UVC → Memory Image → Mastering → Tools → Level Adjustment → I/O/Arduino/PLC → Test Loop → Recipe/Lock → Run/History → Jetson/TensorRT/Hardware Validation.

Do not skip tests and do not start with AI training or production PLC integration before the foundation and safety boundaries are in place.
