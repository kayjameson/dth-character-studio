---
# bump: patch is deliberate — fixes to the existing PHY preset block (no new route, barrel export or command)
"@dth/web": patch
"@dth/rom": patch
---

Fence the Physics preset block at both ends (runtime v107). DTH's G9 Physics Example starts `dth_phy_breast_out_l` at 1 and ends `dth_phy_stomach_hang` at 1, and a pose preset keys only inside its own range — so the left breast ramped in from frame 0 across every JCM/FAC/GEN frame and the belly held through every FBM/MISC frame after the block. The runtime now keys each morph's pre-block value on the frame before the block and closes the block's tail on the frame after it, leaving character-owned dials alone. The fixed PHY PoseAsset rows' left-breast HangForward push also reads `0,0,-5` like its mirror. Run Tools → Refresh assets, then rebuild the ROM.
