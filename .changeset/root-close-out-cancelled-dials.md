---
"@dth/web": patch
"@dth/rom": patch
---

Keep a character's ERC-cancelled shape dials out of the base-ROM close-out (runtime v106). A dial cancelled by a character control (raw -1 plus the control's +1, so value 0) read as an unused ROM pose and was keyed to 0 at the end of the base ROM. That walked it away from its raw value, so the DTH Exporter dropped it from the FBX base mesh and the FBX no longer matched the Alembic. The close-out now treats a non-zero raw value as character-owned too.
