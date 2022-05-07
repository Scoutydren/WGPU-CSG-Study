struct Shape {
  shape_id: u32
}
@group(1) @binding(1) var<uniform> shape : Shape;

struct CanvasConstants {
  size: vec2<f32>
};
@group(2) @binding(0) var<uniform> canvas : CanvasConstants;

struct Mouse {
  pos: vec2<f32>
};
@group(3) @binding(0) var<uniform> mouse : Mouse;

@group(4) @binding(0) var mySampler: sampler;
@group(4) @binding(1) var myTexture: texture_cube<f32>;

let SPHERE: u32 = 0u;
let BOX: u32 = 1u;
let ROUNDBOX: u32 = 2u;
let TORUS: u32 = 3u;
let CAPPEDTORUS: u32 = 4u;
let LINK: u32 = 5u;
let HEXPRISM: u32 = 6u;
let TRIPRISM: u32 = 7u;
let CONE: u32 = 8u;
let CUTHOLLOWSPHERE: u32 = 9u;
let OCTAHEDRON: u32 = 10u;
let DEATHSTAR: u32 = 11u;

let PI: f32 = 3.14159265359;
let DEG_TO_RAD : f32 = 0.0174532925; // PI / 180

fn ray_dir(fov: f32, size: vec2<f32>, pos: vec2<f32>) -> vec3<f32> {
	var xy: vec2<f32> = pos - size * 0.5;

	var cot_half_fov: f32 = tan(( 90.0 - fov * 0.5 ) * DEG_TO_RAD);	
	var z: f32 = size.y * 0.5 * cot_half_fov;
	
	return normalize(vec3<f32>(xy, -z));
}

fn clampVec3ToPositive(v: vec3<f32>) -> vec3<f32> {
  var clamped_v = vec3<f32>(0.0, 0.0, 0.0);
  clamped_v.x = max(v.x, 0.0);
  clamped_v.y = max(v.y, 0.0);
  clamped_v.z = max(v.z, 0.0);
  return clamped_v; 
}

fn clampVec2ToPositive(v: vec2<f32>) -> vec2<f32> {
  var clamped_v = vec2<f32>(0.0, 0.0);
  clamped_v.x = max(v.x, 0.0);
  clamped_v.y = max(v.y, 0.0);
  return clamped_v; 
}

fn rotationXY(angle: vec2<f32> ) -> mat3x3<f32>{
	var c: vec2<f32> = cos( angle );
	var s: vec2<f32> = sin( angle );
	
	return mat3x3<f32>(
		c.y      ,  0.0, -s.y,
		s.y * s.x,  c.x,  c.y * s.x,
		s.y * c.x, -s.x,  c.y * c.x
	);
}

fn sdBox(p: vec3<f32>, b: vec3<f32>) -> f32 {
    var d: vec3<f32> = abs(p) - b;
    return min(max(d.x,max(d.y,d.z)),0.0) + length(clampVec3ToPositive(d));
}

fn sdRoundBox(p: vec3<f32>, b: vec3<f32>, r:f32 ) -> f32{
  var q: vec3<f32> = abs(p) - b;
  return length(clampVec3ToPositive(q)) + min(max(q.x,max(q.y,q.z)),0.0) - r;
}

fn sdTorus(p: vec3<f32>, t: vec2<f32>) -> f32 {
  var q: vec2<f32> = vec2<f32>(length(p.xz)-t.x,p.y);
  return length(q)-t.y;
}

fn sdCappedTorus(p: vec3<f32>, sc: vec2<f32>, ra: f32, rb: f32) -> f32{
  let q = vec3<f32>(abs(p.x), p.y, p.z);
  let k = select(length(q.xy), dot(q.xy, sc), sc.y * q.x > sc.x * q.y);
  return sqrt(dot(q, q) + ra * ra - 2. * ra * k) - rb;
}

fn sdSphere(pos: vec3<f32>, r: f32) -> f32 {
	return length(pos) - r;
}

fn sdLink(p: vec3<f32>, le: f32, r1: f32, r2: f32) -> f32 {
  var q: vec3<f32> = vec3<f32>( p.x, max(abs(p.y)-le,0.0), p.z );
  return length(vec2<f32>(length(q.xy)-r1,q.z)) - r2;
}

fn sdHexPrism(p: vec3<f32>, h: vec2<f32>) -> f32 {
  let k: vec3<f32> = vec3<f32>(-0.8660254, 0.5, 0.57735);
  var pos_p = abs(p);
  var pos_p_xy = vec2<f32>(pos_p.x, pos_p.y);
  var temp = 2.0*min(dot(k.xy, pos_p.xy), 0.0)*k.xy;
  pos_p.x = (pos_p_xy - temp).x;
  pos_p.y = (pos_p_xy - temp).y;
  
  var d: vec2<f32> = vec2<f32>(
       length(pos_p.xy-vec2<f32>(clamp(pos_p.x,-k.z*h.x,k.z*h.x), h.x))*sign(pos_p.y-h.x),
       pos_p.z-h.y );
  return min(max(d.x,d.y),0.0) + length(clampVec2ToPositive(d));
}

fn sdTriPrism(p: vec3<f32>, h: vec2<f32>) -> f32 {
  var q: vec3<f32> = abs(p);
  return max(q.z-h.y,max(q.x*0.866025+p.y*0.5,-p.y)-h.x*0.5);
}

fn sdCutHollowSphere(p: vec3<f32>, r: f32, h: f32, t: f32) -> f32
{
  // sampling independent computations (only depend on shape)
  var w: f32 = sqrt(r*r-h*h);
  
  // sampling dependant computations
  var q: vec2<f32> = vec2<f32>( length(p.xz), p.y );
  if (h*q.x<w*q.y) {
      return length(q-vec2<f32>(w,h)) - t;
  } else {
      return abs(length(q)-r) - t;
  }
}

fn sdCone(p: vec3<f32>, c: vec2<f32>, h: f32 ) -> f32 {
  // c is the sin/cos of the angle, h is height
  // Alternatively pass q instead of (c,h),
  // which is the point at the base in 2D
  var q: vec2<f32> = h*vec2<f32>(c.x/c.y,-1.0);
    
  var w: vec2<f32> = vec2<f32>( length(p.xz), p.y );
  var a: vec2<f32> = w - q*clamp( dot(w,q)/dot(q,q), 0.0, 1.0 );
  var b: vec2<f32> = w - q*vec2<f32>( clamp( w.x/q.x, 0.0, 1.0 ), 1.0 );
  var k: f32 = sign( q.y );
  var d: f32 = min(dot( a, a ),dot(b, b));
  var s: f32 = max( k*(w.x*q.y-w.y*q.x),k*(w.y-q.y)  );
  return sqrt(d)*sign(s);
}

fn sdOctahedron(p: vec3<f32>, s: f32) -> f32
{
  var q: vec3<f32> = abs(p);
  let m = q.x + q.y + q.z - s;
  if (3. * q.x < m) {q = q.xyz;}
  else {if (3. * q.y < m) {q = q.yzx;}
        else {if (3. * q.z < m) {q = q.zxy;}
              else {return m * 0.57735027;}}}
  let k = clamp(0.5 * (q.z - q.y + s), 0., s);
  return length(vec3<f32>(q.x, q.y - s + k, q.z - k)); 
}

fn sdDeathStar(p2: vec3<f32>, ra: f32, rb: f32, d: f32 ) -> f32
{
  // sampling independent computations (only depend on shape)
  var a: f32 = (ra*ra - rb*rb + d*d)/(2.0*d);
  var b: f32 = sqrt(max(ra*ra-a*a,0.0));
	
  // sampling dependant computations
  var p: vec2<f32> = vec2<f32>( p2.x, length(p2.yz) );
  if( p.x*b-p.y*a > d*max(b-p.y,0.0) ) {
    return length(p-vec2<f32>(a,b));
  }
  else {
    return max( (length(p          )-ra),
               -(length(p-vec2<f32>(d,0.0))-rb));
  }
}

fn sdUnion(d0: f32, d1: f32 ) -> f32 {
    return min(d0, d1);
}

fn sdInter(d0: f32, d1: f32) -> f32 {
    return max( d0, d1 );
}

fn sdSub(d0: f32, d1: f32) -> f32 {
    return max(d0, -d1);
}

//get distance in the world
fn dist_field(p: vec3<f32>) -> f32{
//  p = sdRep( p, vec3<f32>( 4.0 ) );
//  p = sdTwist( p, 3.0 );
  //var d0 = sdBox( p, vec3<f32>(0.5));
  var i: u32 = shape.shape_id;
  // var test: u32 = config.numLights;
  var d1: f32;
  if (shape.shape_id == SPHERE)  { 
    d1 = sdSphere( p, 0.6 );
  } else if (shape.shape_id == BOX) {
    d1 = sdBox( p, vec3<f32>(0.5));
  } else if (shape.shape_id == ROUNDBOX) {
    d1 = sdRoundBox( p, vec3<f32>(0.5), 0.2 );
  } else if (shape.shape_id == TORUS) {
    d1 = sdTorus( p, vec2<f32>(0.5,0.2) );
  } else if (shape.shape_id == CAPPEDTORUS) {
    d1 = sdCappedTorus( p, vec2<f32>(0.5,0.2), 0.2, 0.1 );
  } else if (shape.shape_id == LINK) {
    d1 = sdLink( p, 0.5, 0.2, 0.1 );
  } else if (shape.shape_id == HEXPRISM) {
    d1 = sdHexPrism( p, vec2<f32>(0.5,0.5) );
  } else if (shape.shape_id == TRIPRISM) {
    d1 = sdTriPrism( p, vec2<f32>(0.5,0.2) );
  } else if (shape.shape_id == CONE) {
    d1 = sdCone( p, vec2<f32>(0.5,0.5), 0.5 );
  } else if (shape.shape_id == CUTHOLLOWSPHERE) {
    d1 = sdCutHollowSphere( p, 0.6, 0.3, 0.1 );
  } else if (shape.shape_id == OCTAHEDRON) {
    d1 = sdOctahedron( p, 0.5 );
  } else if (shape.shape_id == DEATHSTAR) {
    d1 = sdDeathStar( p, 0.5, 0.2, 0.1 );
  }
  return d1;
  //return d + sfDisp( p * 2.5 );
  // return sdUnion_s( d + sfDisp( p * 2.5 * sin( iTime * 1.01 ) ), d1, 0.1 );
}

//get gradient in the world
fn gradient(pos: vec3<f32>) -> vec3<f32> {
  // TODO : Fix this later (uniforms.grad_step)
	var dx: vec3<f32> = vec3<f32>( 0.02, 0.0, 0.0 );
	var dy: vec3<f32> = vec3<f32>( 0.0, 0.02, 0.0 );
	var dz: vec3<f32> = vec3<f32>( 0.0, 0.0, 0.02 );
	return normalize (
		vec3<f32>(
			dist_field( pos + dx ) - dist_field( pos - dx ),
			dist_field( pos + dy ) - dist_field( pos - dy ),
			dist_field( pos + dz ) - dist_field( pos - dz )			
		)
	);
}

fn fresnel(F0:  vec3<f32>, h: vec3<f32>, l: vec3<f32>) -> vec3<f32>{
	return F0 + ( 1.0 - F0 ) * pow( clamp( 1.0 - dot( h, l ), 0.0, 1.0 ), 5.0 );
}

fn shading(v: vec3<f32>, n: vec3<f32>, dir: vec3<f32>, eye: vec3<f32>) -> vec3<f32> {
	// ...add lights here...
	
	var shininess: f32 = 16.0;
	
	var final: vec3<f32> = vec3<f32>( 0.0 );
	
	var ref: vec3<f32>  = reflect( dir, n );
    
    var Ks: vec3<f32> = vec3<f32>( 0.5 );
    var Kd: vec3<f32> = vec3<f32>( 1.0 );
	
	// light 0
	{
		var light_pos: vec3<f32> = vec3<f32>( 20.0, 20.0, 20.0 );
		var light_color: vec3<f32> = vec3<f32>( 1.0, 0.7, 0.7 );
	
		var vl: vec3<f32> = normalize( light_pos - v );
	
		var diffuse: vec3<f32> = Kd * vec3<f32>( max( 0.0, dot( vl, n ) ) );
		var specular: vec3<f32> = vec3<f32>( max( 0.0, dot( vl, ref ) ) );
		
        var F: vec3<f32> = fresnel( Ks, normalize( vl - dir ), vl );
		specular = pow( specular, vec3<f32>( shininess ) );
		
		final += light_color * mix( diffuse, specular, F ); 
	}
	
	// light 1
	{
		var light_pos: vec3<f32>   = vec3<f32>( -20.0, -20.0, -30.0 );
		var light_color: vec3<f32> = vec3<f32>( 0.5, 0.7, 1.0 );
	
		var vl: vec3<f32> = normalize( light_pos - v );
	
		var diffuse: vec3<f32> = Kd * vec3<f32>( max( 0.0, dot( vl, n ) ) );
		var specular: vec3<f32> = vec3<f32>( max( 0.0, dot( vl, ref ) ) );
        
        var F: vec3<f32> = fresnel( Ks, normalize( vl - dir ), vl );
		specular = pow( specular, vec3<f32>( shininess ) );
		
		final += light_color * mix( diffuse, specular, F );
	}

  // TODO : Fix this later sampling the cubemap
  // final += texture( iChannel0, ref ).rgb * fresnel( Ks, n, -dir );
    
	return final;
}


fn ray_marching(o: vec3<f32>, dir: vec3<f32>, depth: ptr<function, f32>, n: ptr<function, vec3<f32>>) -> bool {
	  var t: f32 = 0.0;
    var d: f32 = 10000.0;
    var dt: f32 = 0.0;
    for (var i: i32 = 0; i < 128; i++) {
        var v: vec3<f32> = o + dir * t;
        d = dist_field( v );
        if ( d < 0.001 ) {
            break;
        }
        dt = min( abs(d), 0.1 );
        t += dt;
        if ( t > *depth ) {
            break;
        }
    }
    
    if ( d >= 0.001 ) {
        return false;
    }
    
    t -= dt;
    for (var i: i32 = 0; i < 4; i++ ) {
        dt *= 0.5;
        
        var v: vec3<f32>  = o + dir * ( t + dt );
        if ( dist_field( v ) >= 0.001 ) {
            t += dt;
        }
    }
    
    *depth = t;
    // This is bad 
    *n = normalize( gradient( o + dir * t ) );
    return true;
    
}

@stage(fragment)
fn main(@builtin(position) coord : vec4<f32>)
     -> @location(0) vec4<f32> {
  
  // Convert coordinate system from top left to bottom left. 
  var new_coord : vec4<f32> = vec4<f32>( coord.x, canvas.size.y - coord.y, coord.z, coord.w );
  var dir: vec3<f32> = ray_dir( 45.0, canvas.size.xy, new_coord.xy );

  var new_mouse_pos: vec2<f32> = vec2<f32>(mouse.pos.x, canvas.size.y - mouse.pos.y);
	
	// // default ray origin
	var eye: vec3<f32> = vec3<f32>( 0.0, 0.0, 3.5 );

	//NON-URGENT FIX : Fix this later rotate camera
	var rot: mat3x3<f32> = rotationXY((new_mouse_pos - canvas.size.xy * 0.5 ).yx * vec2<f32>( 0.01, -0.01 ));
	dir = rot * dir;
	eye = rot * eye;
	
	// ray marching TODO: Fix this later
    // var depth: f32 = uniforms.clip_far;
  var depth: f32 = 1000.0;
  var n: vec3<f32> = vec3<f32>( 0.0 );

  var fragColor: vec4<f32> = vec4<f32>( 0.0 );
	if (!ray_marching( eye, dir, &depth, &n)) {

        // TODO : Fix this later
    // fragColor = textureSample(myTexture, mySampler, dir);
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
	}
	
	// // shading
	var pos: vec3<f32> = eye + dir * depth;
    
  var color: vec3<f32> = shading( pos, n, dir, eye );
	fragColor = vec4<f32>( pow(color, vec3<f32>(1.0/1.2)), 1.0);

  return fragColor;
  // return vec4<f32>(dir.x, dir.y, dir.z, 1.0);

  //return vec4<f32>(1.0, 1.0, 0.0, 1.0);
}


// @stage(fragment)
// fn main(@location(0) fragUV: vec2<f32>,
//         @location(1) fragPosition: vec4<f32>) -> @location(0) vec4<f32> {
//   return textureSample(myTexture, mySampler, fragUV);
// }