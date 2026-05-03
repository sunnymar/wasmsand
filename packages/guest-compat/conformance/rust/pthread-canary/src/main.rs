//! Paired Rust signature canary for the pthread Tier 1 surface.

#![allow(non_camel_case_types)]

use core::ffi::c_void;

type pthread_t = u32;
type pthread_key_t = u32;

#[repr(C)]
struct pthread_mutex_t {
    storage: [u32; 8],
}

extern "C" {
    fn pthread_create(
        thread: *mut pthread_t,
        attr: *const c_void,
        start_routine: extern "C" fn(*mut c_void) -> *mut c_void,
        arg: *mut c_void,
    ) -> i32;
    fn pthread_join(thread: pthread_t, retval: *mut *mut c_void) -> i32;
    fn pthread_self() -> pthread_t;
    fn pthread_mutex_lock(mutex: *mut pthread_mutex_t) -> i32;
    fn pthread_mutex_unlock(mutex: *mut pthread_mutex_t) -> i32;
    fn pthread_key_create(key: *mut pthread_key_t, destructor: Option<extern "C" fn(*mut c_void)>)
        -> i32;
    fn pthread_setspecific(key: pthread_key_t, value: *const c_void) -> i32;
    fn pthread_getspecific(key: pthread_key_t) -> *mut c_void;
}

extern "C" fn thread_main(arg: *mut c_void) -> *mut c_void {
    arg
}

fn smoke_mode() -> i32 {
    let mut mutex = pthread_mutex_t { storage: [0; 8] };
    let mut key: pthread_key_t = 0;
    let value = 7usize as *const c_void;

    let rc = unsafe {
        pthread_self();
        pthread_mutex_lock(&mut mutex);
        pthread_mutex_unlock(&mut mutex);
        pthread_key_create(&mut key, None);
        pthread_setspecific(key, value);
        pthread_getspecific(key);

        let mut thread: pthread_t = 0;
        let mut retval: *mut c_void = core::ptr::null_mut();
        let create_rc = pthread_create(&mut thread, core::ptr::null(), thread_main, value as *mut c_void);
        let join_rc = if create_rc == 0 {
            pthread_join(thread, &mut retval)
        } else {
            create_rc
        };
        create_rc | join_rc
    };

    if rc == 0 {
        println!("pthread-rust=ok");
        0
    } else {
        eprintln!("pthread-rust=failed:{rc}");
        1
    }
}

fn main() {
    std::process::exit(smoke_mode());
}
