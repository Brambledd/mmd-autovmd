@pose sq_top {
    center reset;
    upper_body reset;
    upper_body2 reset;
    neck reset;
    head reset;
    waist reset;
    leg_l sway left 4;
    leg_r sway right 4;
    knee_l reset;
    knee_r reset;
    ankle_l reset;
    ankle_r reset;
    arm_l bend forward 38;
    arm_r bend forward 38;
    elbow_l bend forward 12;
    elbow_r bend forward 12;
    wrist_l reset;
    wrist_r reset;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face にこり 0.6;
    face 笑い 0;
    face ウィンク 0;
}

@pose sq_antic {
    center reset;
    upper_body bend backward 6;
    upper_body2 bend backward 4;
    neck bend backward 4;
    head bend backward 4;
    waist reset;
    leg_l sway left 4;
    leg_r sway right 4;
    knee_l reset;
    knee_r reset;
    ankle_l reset;
    ankle_r reset;
    arm_l bend forward 24, sway left 22;
    arm_r bend forward 24, sway right 22;
    elbow_l bend forward 14;
    elbow_r bend forward 14;
    wrist_l reset;
    wrist_r reset;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face にこり 0.8;
    face 笑い 0;
    face ウィンク 0;
}

@pose sq_hinge {
    center move down 1;
    center move backward 0.8;
    plant feet;
    waist bend forward 15;
    upper_body bend forward 5;
    upper_body2 bend backward 5;
    neck reset;
    head sway right 3;
    leg_l bend forward 30, sway left 4;
    leg_r bend forward 30, sway right 4;
    knee_l bend backward 50;
    knee_r bend backward 50;
    ankle_l bend backward 20;
    ankle_r bend backward 20;
    reach hand_l to front_l;
    reach hand_r to front_r;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face にこり 0.6;
    face 笑い 0;
    face ウィンク 0;
}

@pose sq_bottom {
    center move down 4;
    center move backward 2.7;
    plant feet;
    waist bend forward 25;
    upper_body bend forward 10;
    upper_body2 bend backward 8, sway left 3;
    neck reset;
    head sway right 6;
    leg_l bend forward 90, sway left 17;
    leg_r bend forward 90, sway right 17;
    knee_l bend backward 120;
    knee_r bend backward 120;
    ankle_l bend backward 30;
    ankle_r bend backward 30;
    reach hand_l to front_l;
    reach hand_r to front_r;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face にこり 0.5;
    face 笑い 0.4;
    face ウィンク 0;
}

@pose sq_bottom_wink {
    center move down 4;
    center move backward 2.7;
    plant feet;
    waist bend forward 25;
    upper_body bend forward 10;
    upper_body2 bend backward 8, sway left 3;
    neck reset;
    head sway right 10;
    leg_l bend forward 90, sway left 17;
    leg_r bend forward 90, sway right 17;
    knee_l bend backward 120;
    knee_r bend backward 120;
    ankle_l bend backward 30;
    ankle_r bend backward 30;
    reach hand_l to front_l;
    reach hand_r to front_r;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face にこり 0.7;
    face 笑い 0.6;
    face ウィンク 1;
}

@pose sq_bounce {
    center move down 3.3;
    center move backward 2.2;
    plant feet;
    waist bend forward 21;
    upper_body bend forward 8;
    upper_body2 bend backward 7, sway left 2;
    neck reset;
    head sway right 5;
    leg_l bend forward 76, sway left 14;
    leg_r bend forward 76, sway right 14;
    knee_l bend backward 104;
    knee_r bend backward 104;
    ankle_l bend backward 27;
    ankle_r bend backward 27;
    reach hand_l to front_l;
    reach hand_r to front_r;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face にこり 0.6;
    face 笑い 0.4;
    face ウィンク 0;
}

@pose sq_over {
    center reset;
    upper_body bend backward 7;
    upper_body2 bend backward 5;
    neck bend backward 3;
    head bend backward 4, sway left 4;
    waist reset;
    leg_l sway left 4;
    leg_r sway right 4;
    knee_l reset;
    knee_r reset;
    ankle_l reset;
    ankle_r reset;
    arm_l bend forward 16, sway right 24;
    arm_r bend forward 16, sway left 24;
    elbow_l bend forward 10;
    elbow_r bend forward 10;
    wrist_l reset;
    wrist_r reset;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face にこり 0.8;
    face 笑い 0.5;
    face ウィンク 0;
}

@animation squat_lively {
    0: sq_top;
    0.5: sq_antic;
    0.7: sq_hinge;
    1.2: sq_bottom;
    1.35: sq_bounce;
    1.6: sq_bottom;
    2.35: sq_top;
    2.55: sq_over;
    2.9: sq_top;
    3.2: sq_antic;
    3.4: sq_hinge;
    3.8: sq_bottom;
    3.95: sq_bounce;
    4.15: sq_bottom;
    4.3: sq_bounce;
    4.5: sq_bottom;
    5.3: sq_top;
    5.5: sq_over;
    5.85: sq_top;
    6.2: sq_antic;
    6.45: sq_hinge;
    7.2: sq_bottom;
    7.8: sq_bottom_wink;
    8.5: sq_top;
    8.7: sq_over;
    9.0: sq_top;
}

main {
    squat_lively;
}
