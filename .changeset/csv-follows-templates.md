---
"@dth/web": patch
"@dth/rom": patch
---

Keep the PoseAsset CSV in step with its templates (schema v39). Each character now records a fingerprint of the templates its CSV was generated from, so a template change makes that CSV stale and Refresh assets regenerates it; before, a runtime bump regenerated only the scripts, and a template fix never reached an existing CSV. In dev, generating or refreshing now stops with an error if the running app holds an out-of-date copy of a template or runtime file, after a missed file-watcher event produced v107 scripts paired with a CSV from the old template.
