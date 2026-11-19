//! Replays `fixtures/allocator.json` (made by `gen/allocator.mjs` in Node).

use mos::lower::allocator::LocalAllocator;
use mos::zp::ZpHole;
use serde_json::Value;

#[test]
fn local_allocator_sequences_match_js() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("fixtures/allocator.json")).unwrap();
    let (mut steps_seen, mut errors_seen) = (0, 0);
    for row in &rows {
        let a = row["args"].as_array().unwrap();
        let holes: Vec<ZpHole> = if a[2].is_null() {
            Vec::new()
        } else {
            serde_json::from_value(a[2].clone()).unwrap()
        };
        let mut al = LocalAllocator::new(a[0].as_i64().unwrap(), a[1].as_i64().unwrap(), &holes);
        let mut marks = Vec::new();
        for step in row["result"].as_array().unwrap() {
            let arg = &step["arg"];
            let res: Result<Option<i64>, String> = match step["op"].as_str().unwrap() {
                "mark" => {
                    marks.push(al.mark());
                    Ok(marks.last().copied())
                }
                "release" => {
                    al.release(marks[usize::try_from(arg.as_i64().unwrap()).unwrap()]);
                    Ok(None)
                }
                "alloc" => al.alloc(arg.as_str().unwrap()).map(Some),
                "alloc16" => al.alloc16(arg.as_str().unwrap()).map(Some),
                op => panic!("{op}"),
            };
            match (&res, step.get("error")) {
                (Ok(v), None) => assert_eq!(
                    v.map(Value::from).unwrap_or(Value::Null),
                    step["result"],
                    "{step}"
                ),
                (Err(e), Some(want)) => {
                    errors_seen += 1;
                    assert_eq!(e.as_str(), want.as_str().unwrap());
                }
                _ => panic!("{res:?} vs {step}"),
            }
            assert_eq!(al.used(), step["used"].as_i64().unwrap(), "{step}");
            steps_seen += 1;
        }
    }
    assert!(
        steps_seen > 30 && errors_seen > 5,
        "{steps_seen} {errors_seen}"
    );
}
