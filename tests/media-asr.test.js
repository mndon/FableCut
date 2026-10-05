"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { fixture } = require("./helpers/cli");
const cliDir = process.env.FABLECUT_TEST_CLI_DIR || path.resolve(__dirname, "../cli");
const { runMediaAsr, validateAsrLocalPath } = require(path.join(cliDir, "lib/media"));
const BODY = '{"rich_result":null,"channel":[]}\n';
async function setup(t) {
  const f = fixture(t);
  const created = await f.run(["create-project", "--name", "media asr"]);
  assert.equal(created.code, 0, created.stderr);
  const id = JSON.parse(created.stdout).project_id;
  const dir = path.join(f.dataDir, "projects", id), file = path.join(dir, "project.json");
  const mediaDir = path.join(dir, "media");
  fs.writeFileSync(path.join(mediaDir, "speech.wav"), "synthetic audio");
  const doc = JSON.parse(fs.readFileSync(file));
  doc.media.push({ id: "m1", kind: "audio", src: `/projects/${id}/media/speech.wav` });
  fs.writeFileSync(file, JSON.stringify(doc));
  const read = () => JSON.parse(fs.readFileSync(file));
  const write = doc => fs.writeFileSync(file, JSON.stringify(doc));
  const local = { paths: {}, store: {
    context: () => ({ id, mediaDir, analysisDir: path.join(dir, "analysis") }), read,
    update: (id, fn) => { const value = fn(read()); write(value); return value; },
  } };
  return { ...f, id, local, read, write, args: ["media", "--action", "asr", "--project-id", id, "--media-id", "m1"] };
}
test("media CLI reuses, copies and validates local ASR without auth; removed commands fail", async t => {
  const f = await setup(t), transcript = path.join(f.home, "transcript.json");
  fs.writeFileSync(transcript, BODY);
  const doc = f.read(); doc.media[0].asrLocalPath = transcript; f.write(doc);
  const reused = await f.run(f.args);
  assert.equal(reused.code, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).path, transcript);
  assert.equal(JSON.parse(reused.stdout).revision, doc.revision);
  const copied = await f.run([...f.args, "--output", "copy.json"]);
  assert.equal(copied.code, 0, copied.stderr);
  assert.equal(fs.realpathSync(f.read().media[0].asrLocalPath), fs.realpathSync(path.join(f.home, "copy.json")));
  assert.equal(fs.readFileSync(path.join(f.home, "copy.json"), "utf8"), BODY);
  assert.equal(JSON.parse(copied.stdout).json_url, undefined);
  const collision = await f.run([...f.args, "--output", transcript]);
  assert.notEqual(collision.code, 0);
  for (const args of [["asr"], ["media"], ["media", "--action", "other"], f.args.slice(0, -2), [...f.args.slice(0,-1), "missing"], ["import-media", "--existing-asr"]]) {
    assert.notEqual((await f.run(args)).code, 0, args.join(" "));
  }
  assert.match((await f.run(["asr"])).stderr, /Unknown command: asr/);
  fs.writeFileSync(path.join(f.home, "copy.json"), "invalid");
  assert.notEqual((await f.run(f.args)).code, 0);
});
test("URL download restores stale local binding and failed downloads leave project unchanged", async t => {
  const f = await setup(t);
  let valid = false;
  const server = http.createServer((req,res) => res.end(valid ? BODY : "invalid"));
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const doc = f.read(); doc.media[0].asrUrl = `http://127.0.0.1:${server.address().port}/result`;
  doc.media[0].asrLocalPath = path.join(f.home,"missing.json"); f.write(doc);
  assert.notEqual((await f.run(f.args)).code,0);
  assert.deepEqual(f.read(),doc);
  valid = true;
  const result = await f.run(f.args);
  assert.equal(result.code,0,result.stderr);
  assert.equal(fs.readFileSync(f.read().media[0].asrLocalPath,"utf8"),BODY);
  assert.equal(f.read().media[0].asrUrl,doc.media[0].asrUrl);
});
test("transcription binds URL before download failure; retry downloads without retranscribing", async t => {
  const f = await setup(t); let transcriptions = 0;
  const transcribe = async () => { transcriptions++; const doc = f.read(); doc.name = "Concurrent edit"; doc.revision++; f.write(doc); return {json_url:"https://example.com/asr"}; };
  await assert.rejects(runMediaAsr(f.local,f.id,"m1",{}, {transcribe, download: async () => { throw new Error("Download failed"); }}), /json_url=https/);
  assert.equal(f.read().media[0].asrUrl,"https://example.com/asr");
  assert.equal(f.read().media[0].asrLocalPath,undefined);
  const result = await runMediaAsr(f.local,f.id,"m1",{}, {transcribe, download: async (url,target,options) => {
    fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,BODY); options.validate(target); return {path:target};
  }});
  assert.equal(transcriptions,1); assert.equal(f.read().name,"Concurrent edit");
  assert.equal(result.path,f.read().media[0].asrLocalPath);
});
test("concurrent deletion, source changes and ASR binding changes refuse commits", async t => {
  for (const change of [doc => { doc.media=[]; },doc => { doc.media[0].src="/other"; },doc => { doc.media[0].asrUrl="https://example.com/other"; }]) {
    const f = await setup(t);
    await assert.rejects(runMediaAsr(f.local,f.id,"m1",{}, {transcribe: async () => {
      const doc=f.read(); change(doc); f.write(doc); return {json_url:"https://example.com/asr"};
    }}), /CONFLICT.*json_url=/);
    assert.notEqual(f.read().media[0]?.asrUrl,"https://example.com/asr");
  }
});
test("cancelled operations, unsupported kinds and remote sources do not transcribe", async t => {
  const f=await setup(t), controller=new AbortController(); controller.abort();
  await assert.rejects(runMediaAsr(f.local,f.id,"m1",{}, {signal:controller.signal}),/cancelled/);
  const doc=f.read(); doc.media[0].src="https://example.com/audio.wav"; f.write(doc);
  await assert.rejects(runMediaAsr(f.local,f.id,"m1",{}),/import remote/);
  doc.media[0].kind="image"; f.write(doc);
  await assert.rejects(runMediaAsr(f.local,f.id,"m1",{}),/audio or video/);
  for(const value of [null,true,"","relative.json"]) assert.throws(()=>validateAsrLocalPath(value),/absolute/);
  for(const value of ["/other/device/asr.json","C:\\other\\asr.json"]) assert.equal(validateAsrLocalPath(value),value);
});
test("import validates local ASR and set-project preserves foreign absolute paths", async t => {
  const f=await setup(t), source=path.join(f.home,"image.svg"), transcript=path.join(f.home,"local.json");
  fs.writeFileSync(source,'<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(transcript,BODY);
  const result=await f.run(["import-media","--project-id",f.id,"--path",source,"--asr-local-path",transcript]);
  assert.equal(result.code,0,result.stderr);
  const imported=JSON.parse(result.stdout).media;
  assert.equal(imported.asrLocalPath,transcript);
  for(const value of [path.join(f.home,"missing.json"),source]) {
    assert.notEqual((await f.run(["import-media","--project-id",f.id,"--path",source,"--asr-local-path",value])).code,0);
  }
  const doc=f.read(); doc.media[0].asrLocalPath="C:\\another-device\\result.json";
  assert.equal((await f.run(["set-project","--project-id",f.id,"--document",JSON.stringify(doc)])).code,0);
  doc.revision=f.read().revision; doc.media[0].asrLocalPath="relative.json";
  assert.notEqual((await f.run(["set-project","--project-id",f.id,"--document",JSON.stringify(doc)])).code,0);
});
test("download completion cannot overwrite a concurrent ASR binding and cancellation keeps saved URL", async t => {
  const f=await setup(t), controller=new AbortController();
  const transcribe=async()=>({json_url:"https://example.com/asr"});
  await assert.rejects(runMediaAsr(f.local,f.id,"m1",{}, {signal:controller.signal, transcribe,download:async()=>{controller.abort();throw new Error("Download cancelled");}}), /cancelled.*json_url=/);
  assert.equal(f.read().media[0].asrUrl,"https://example.com/asr");
  await assert.rejects(runMediaAsr(f.local,f.id,"m1",{}, {download:async(url,target)=>{
    const doc=f.read();doc.media[0].asrLocalPath="/other/result.json";f.write(doc);return {path:target};
  }}), /CONFLICT.*path=/);
  assert.equal(f.read().media[0].asrLocalPath,"/other/result.json");
});
