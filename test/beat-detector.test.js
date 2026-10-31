import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeatDetector } from '../beat-detector.js';
test('detects peaks while limiting repeated beats', () => {
  let beats=0; const detector=new BeatDetector(()=>beats++);
  detector.feed(0.01,1000); detector.feed(0.5,1100); detector.feed(0.8,1200);
  assert.equal(beats,1);
  for (let i=0;i<40;i++) detector.feed(0.01,1300+i*20);
  detector.feed(0.8,2200); assert.equal(beats,2);
});
test('detects a steady 120 BPM pulse without skipping alternate beats', () => {
  const beats=[]; const detector=new BeatDetector(() => beats.push(true));
  for (let time=1000; time<3100; time+=20) {
    const phase=(time-1000)%500;
    detector.feed(phase<60 ? 0.55 : 0.015, time);
  }
  assert.equal(beats.length,5);
});
test('locks to a steady pulse and follows a later tempo change', () => {
  let now=100000; const beats=[]; const detector=new BeatDetector(() => beats.push(now));
  for (; now<140000; now+=10) {
    const period=now>=118000 ? 650 : 500;
    const phase=(now-(now>=118000 ? 118000 : 100000))%period;
    detector.feed(phase<35 ? 0.6 : phase>period/2 && phase<period/2+30 ? 0.14 : 0.015, now);
  }
  const early=beats.filter(time => time>=112000 && time<117000);
  const late=beats.filter(time => time>=135000);
  assert.ok(early.length>=8 && early.slice(1).every((time,index) => Math.abs(time-early[index]-500)<=35));
  assert.ok(late.length>=6 && late.slice(1).every((time,index) => Math.abs(time-late[index]-650)<=35));
  assert.ok(Math.abs(detector.period-650)<=25);
});
test('beat offset moves the next predicted beat', () => {
  const detector=new BeatDetector(() => {});
  detector.nextBeat=10000;
  detector.setOffset(150); assert.equal(detector.nextBeat,10150);
  detector.setOffset(-50); assert.equal(detector.nextBeat,9950);
});
