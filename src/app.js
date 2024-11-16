const Genetic = require('genetic-js');

(() => {

const InputFileUpload = document.getElementById("file-upload");
let InputCtx = document.getElementById('input-canvas').getContext("2d");
InputCtx.canvas.width = 100;
InputCtx.canvas.height = 100;

let ResultCtx = document.getElementById('result-canvas').getContext("2d");
ResultCtx.canvas.width = 100;
ResultCtx.canvas.height = 100;

const ButtonRandom = document.getElementById('random');
const ButtonFit = document.getElementById('fit');
const ButtonContour = document.getElementById('contour');


InputFileUpload.addEventListener("change", onChange);
ButtonRandom.addEventListener("click", onRandom);
ButtonFit.addEventListener("click", onFit);
ButtonContour.addEventListener("click", onContour);


function onChange() {
    const file = InputFileUpload.files;
    if (file) {
        const fileReader = new FileReader();

        fileReader.onload = (event) => {
            let img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                let w = InputCtx.canvas.width;
                let h = InputCtx.canvas.height;
                
                InputCtx.drawImage(img,0,0,w,h);

                let imgData = InputCtx.getImageData(0,0,w,h);
                let data = imgData.data;
                for (let idx = 0; idx < data.length; idx += 4) {
                    let avg = Math.round((data[idx] + data[idx+1] + data[idx+2]) / 3);
                    data[idx] = avg;
                    data[idx+1] = avg;
                    data[idx+2] = avg;
                    data[idx+3] = 255;
                }
                InputCtx.putImageData(imgData, 0, 0);
            }
        };
        
        fileReader.readAsDataURL(file[0]);
    }
}

function onContour() {
    console.log("contour");

    let contour = findContour(InputCtx);

    let w = InputCtx.canvas.width;
    let h = InputCtx.canvas.height;

    ResultCtx.clearRect(0,0,w,h);
    ResultCtx.drawImage(InputCtx.canvas, 0, 0);

    ResultCtx.fillStyle = "rgb(255 0 0)";
    for (let i = 0; i < contour.length; i++) {
        ResultCtx.fillStyle = `rgb(${Math.floor(255*(1-i/contour.length))} 0 0)`;
        ResultCtx.fillRect(contour[i][0], contour[i][1], 1, 1);
    }

    ResultCtx.fillStyle = "rgb(0 255 0)";
    ResultCtx.fillRect(contour[0][0], contour[0][1], 2, 2);
}

function findContour(ctx, scale) {
    let w = ctx.canvas.width;
    let h = ctx.canvas.height;

    let x;
    let y;
    let arr = [];
    
    for (y = 0; y < h; y++) {
        arr.push([]);
        for (x = 0; x < w; x++) {
            arr[y].push(0);
        }
    }

    let img = ctx.getImageData(0,0,w,h).data;
    for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
            let idx = y * w * 4 + x * 4;
            let val = img[idx];
            if (val != 0 && val != 255) {
                arr[y][x] = 1;
            }
        }
    }

    // All points with conflicts
    let contour = [];
    let mx = 0;
    let my = 0;
    for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
            if (arr[y][x]) {
                if ( y == 0 || y == h-1 || x == 0 || x == w-1 ||
                     !arr[y-1][x] || !arr[y][x-1] || !arr[y][x+1] || !arr[y+1][x] ) {
                    contour.push([x,y]);
                    mx += x;
                    my += y;
                }  
            }
        }
    }
    
    // Find center
    mx /= contour.length;
    my /= contour.length;

    let angleFromCorner = (x,y) => {
        let corner = Math.atan2(-1,-1);
        let angle = Math.atan2(y-my,x-mx);
        if (angle > corner)
            angle -= 2*Math.PI;
        return angle;
    }

    contour.sort( (a,b) => ( angleFromCorner(a[0],a[1]) - angleFromCorner(b[0],b[1]) ) );
    console.log(contour);

    if (scale) {
        for (let i = 0; i < contour.length; i++) {
            contour[i][0] /= w;
            contour[i][1] /= h;
        }
    }

    return contour;
}

let newControlGrid = (N, randomize, contour) => {

    let newPoint = (x,y,z) => {
        return { x:x, y:y, z:z };
    }

    let points = [];
    let edgeN = 0;
    let edgeMax = (N-1) * 4;
    let edgeMap = 
    [
        0,1,2,3,
        11,   4,
        10,   5,
        9,8,7,6
    ];

    for (let j = 0; j < N; j++) {
        points[j] = [];
        for (let i = 0; i < N; i++) {
            points[j][i] = newPoint(
                i/(N-1) + (randomize ? (.5-Math.random()) : 0.0),
                j/(N-1) + (randomize ? ( .5-Math.random()) : 0.0),
                (randomize ? Math.random() : 0.0));

            if (contour &&
                    (j == 0 || j == N-1 || i == 0 || i == N-1)) {
                // edge
                let p = Math.floor((edgeMap[edgeN] / edgeMax) * contour.length);

                points[j][i].x = contour[p][0];
                points[j][i].y = contour[p][1];
                points[j][i].z = Math.random()-0.5;
                points[j][i].contour = p;

                edgeN++;
            }
        }
    }
    
    return points;
}

function drawControlGrid(ctx, controlGrid, $fn) {

    let bezierPoints = (points, $fn) => {
        let res = [];
    
        for (let i = 0; i < $fn; i++) {
            res[i] = { x:0, y:0, z:0 };
        }
    
        if (points.length == 4) {
            for (let i = 0; i < $fn; i++) {
                let t = i/$fn;
                let T = 1-t;
                let p = points;
    
                let a = 1*T*T*T;
                let b = 3*t*T*T;
                let c = 3*t*t*T;
                let d = 1*t*t*t;
    
                res[i].x = a * p[0].x +
                           b * p[1].x +
                           c * p[2].x +
                           d * p[3].x;
    
                res[i].y = a * p[0].y +
                           b * p[1].y +
                           c * p[2].y +
                           d * p[3].y;
                           
                res[i].z = a * p[0].z +
                           b * p[1].z +
                           c * p[2].z +
                           d * p[3].z;
            }
        }
    
        return res;
    }

    let drawQuad = (ctx,W,H,p1,p2,p3,p4) => {
        var z = (p1.z + p2.z + p3.z + p4.z) / 4;
        if (z < 0) z = 0;
        if (z > 1) z = 1;
    
        const grayTone = Math.round(z*255);
        ctx.fillStyle = `rgb(${grayTone} ${grayTone} ${grayTone})`;
    
        ctx.beginPath();
        ctx.moveTo(p1.x * W - .5, p1.y * H - .5);
        ctx.lineTo(p2.x * W + .5, p2.y * H - .5);
        ctx.lineTo(p3.x * W + .5, p3.y * H + .5);
        ctx.lineTo(p4.x * W - .5, p4.y * H + .5);
        ctx.closePath();
        ctx.fill();
    }

    let W = ctx.canvas.width;
    let H = ctx.canvas.height;
    let N = controlGrid.length;

    let luts = [];
    for (let j = 0; j < N; j++) {
        luts[j] =  bezierPoints(controlGrid[j], $fn);
    }

    let pointMap = [];
    for (let y = 0; y < $fn; y++) {
        pointMap[y] = [];
        for (let x = 0; x < $fn; x++) {
            pointMap[y][x] = null;
        }
    }

    for (let x = 0; x < $fn; x++) {
        let midPoints = [];
        for (let j = 0; j < N; j++) {
            midPoints[j] = luts[j][x];
        }

        let midLuts = bezierPoints(midPoints, $fn);

        for (let y = 0; y < $fn; y++) {
            pointMap[y][x] = midLuts[y];
        }
    }

    for (let x1 = 0; x1 < $fn-1; x1++) {
        for (let y1 = 0; y1 < $fn-1; y1++) {
            let x2 = x1+1;
            let y2 = y1+1;

            let p11 = pointMap[y1][x1];
            let p12 = pointMap[y1][x2];
            let p21 = pointMap[y2][x1];
            let p22 = pointMap[y2][x2];

            drawQuad(ctx, W, H, p11, p12, p22, p21);
        }
    }
}

function calculateDistanceCanvas(ctx1, ctx2, numberOfSamples) {
    var arr1 = canvas2array(ctx1);
    var arr2 = canvas2array(ctx2);
    return calculateDistance(arr1, arr2, numberOfSamples);
}

function calculateDistance(arr1, arr2, numberOfSamples) {
    var sumError = 0.0;
    for (var i = 0; i < numberOfSamples; i++) {
        var xy = Math.random();

        let offset1 = Math.round(xy * (arr1.length-1));
        let offset2 = Math.round(xy * (arr2.length-1));

        let v1 = arr1[offset1];
        let v2 = arr2[offset2];
        
        sumError += (v1-v2)**2;
    }

    return sumError/numberOfSamples;
}

function calculateDistance2(arr1, controlGrid, $fn) {
    var sumError = 0.0;
    
    let bezierPoints = (points, $fn) => {
        let res = [];
    
        for (let i = 0; i < $fn; i++) {
            res[i] = { x:0, y:0, z:0 };
        }
    
        if (points.length == 4) {
            for (let i = 0; i < $fn; i++) {
                let t = i/$fn;
                let T = 1-t;
                let p = points;
    
                let a = 1*T*T*T;
                let b = 3*t*T*T;
                let c = 3*t*t*T;
                let d = 1*t*t*t;
    
                res[i].x = a * p[0].x +
                           b * p[1].x +
                           c * p[2].x +
                           d * p[3].x;
    
                res[i].y = a * p[0].y +
                           b * p[1].y +
                           c * p[2].y +
                           d * p[3].y;
                           
                res[i].z = a * p[0].z +
                           b * p[1].z +
                           c * p[2].z +
                           d * p[3].z;
            }
        }
    
        return res;
    }

    let N = controlGrid.length;

    let luts = [];
    for (let j = 0; j < N; j++) {
        luts[j] =  bezierPoints(controlGrid[j], $fn);
    }

    let pointMap = [];
    for (let y = 0; y < $fn; y++) {
        pointMap[y] = [];
        for (let x = 0; x < $fn; x++) {
            pointMap[y][x] = null;
        }
    }

    for (let x = 0; x < $fn; x++) {
        let midPoints = [];
        for (let j = 0; j < N; j++) {
            midPoints[j] = luts[j][x];
        }

        let midLuts = bezierPoints(midPoints, $fn);

        for (let y = 0; y < $fn; y++) {
            pointMap[y][x] = midLuts[y];
        }
    }

    for (let x = 0; x < $fn; x++) {
        for (let y = 0; y < $fn; y++) {
            let p = pointMap[y][x];

            if (p.y < 0 || p.y >= 1 || p.x < 0 || p.x >= 1) {
                sumError += 255**2;
            }
            else {
                let H = Math.floor(Math.sqrt(arr1.length));
                let W = Math.floor(arr1.length / H);
                let yy = Math.floor(p.y * H);
                let xx = Math.floor(p.x * W);

                let err = arr1[yy*W+xx] - p.z*255;
                sumError += err**2;

                let outXX = 0;
                if (x == 0) outXX = -1;
                else if (x == $fn-1) outXX = 1;
                
                let outYY = 0;
                if (y == 0) outYY = -1;
                else if (y == $fn-1) outYY = 1;

                if (outXX || outYY) {
                    outXX = Math.round(xx + 0.03 * W * outXX);
                    outYY = Math.round(yy + 0.03 * H * outYY);

                    if (outXX >= 0 && outXX < W &&
                            outYY >= 0 && outYY < H) {
                        if (arr1[outYY*W+outXX] != 0 && arr1[outYY*W+outXX] != 255) {
                            sumError += 255*255;
                        }
                    }
                }
            }
        }
    }

    //console.error(arr1[2050], sumError, $fn);

    return sumError/($fn**2);
}

function canvas2array(ctx) {
    var imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    var arr = []
    let d = imageData.data;
    for (var i = 0; i < imageData.width * imageData.height; i++) {
        arr[i] = (d[4*i] + d[4*i+1] + d[4*i+2])/3;
    }

    return arr;
}

function onRandom() {
    let w = InputCtx.canvas.width;
    let h = InputCtx.canvas.height;
    let outputCtx = new OffscreenCanvas(w, h).getContext("2d");
    let $fn = 100;

    let points = newControlGrid(4, true);
    drawControlGrid(outputCtx, points, $fn);

    console.log(calculateDistanceCanvas(InputCtx, outputCtx, 100));

    InputCtx.clearRect(0,0,w,h);
    InputCtx.drawImage(outputCtx.canvas, 0, 0);
}

function onFit() {
    let genetic = Genetic.create();

    genetic.width = InputCtx.canvas.width;
    genetic.height = InputCtx.canvas.height;
    genetic.contour = findContour(InputCtx, true);
    genetic.newControlGrid = newControlGrid;
    genetic.drawControlGrid = drawControlGrid;
    genetic.calculateDistance = calculateDistance;
    genetic.calculateDistance2 = calculateDistance2;
    genetic.inputArray = canvas2array(InputCtx);
    genetic.canvas2array = canvas2array;
    
    genetic.seed = () => {
        return this.newControlGrid(4, true, this.contour);
    }

    genetic.fitnessDeep = (grid) => {
        var ctx = new OffscreenCanvas(this.width, this.height).getContext("2d");
        this.drawControlGrid(ctx, grid, 10);
        
        return this.calculateDistance(this.inputArray, this.canvas2array(ctx), 1000);
    }
    genetic.fitness = (grid) => {
        if (Math.random() < 0) {
            return this.fitnessDeep(grid);
        }
        else {
            return this.calculateDistance2(this.inputArray, grid, 33);
        }
    }

    genetic.mutate = (grid) => {
        var j = Math.round(Math.random() * (grid.length-1));
        var i = Math.round(Math.random() * (grid[j].length-1));

        let alpha = 1;
        let dx = alpha * (Math.random() - 0.5);
        let dy = alpha * (Math.random() - 0.5);
        let dz = alpha * (Math.random() - 0.5);
        
        for (var a = -1; a <= 1; a++) {
            for (var b = -1; b <= 1; b++) {
                if (j+a >= 0 && j+a < grid.length &&
                    i+b >= 0 && i+b < grid[j+a].length) {
                    var p = grid[j+a][i+b];

                    if (p.contour || typeof(p.contour) != "undefined") {
                        p.contour += Math.round(this.contour.length*0.05*(Math.random()-0.5));
                        p.contour = (p.contour + this.contour.length) % this.contour.length;

                        p.x = this.contour[p.contour][0];
                        p.y = this.contour[p.contour][1];
                        p.z += dz;
                    }
                    else {
                        p.x += dx;
                        p.y += dy;
                        p.z += dz;
                    }
                }
            }
        }
        

        return grid;
    }

    genetic.crossover = (grid1, grid2) => {
        var j = Math.round(Math.random() * (grid1.length-1));
        var i = Math.round(Math.random() * (grid1[j].length-1));

        for (var a = -1; a <= 1; a++) {
            for (var b = -1; b <= 1; b++) {
                if (j+a >= 0 && j+a < grid1.length &&
                    i+b >= 0 && i+b < grid1[j+a].length) {

                    var p1 = grid1[j+a][i+b];
                    grid1[j+a][i+b] = grid2[j+a][i+b];
                    grid2[j+a][i+b] = p1;

                }
            }
        }
        return [grid1, grid2];
    }

    genetic.optimize = Genetic.Optimize.Minimize;
    genetic.select1 = Genetic.Select1.RandomLinearRank;
    genetic.select2 = Genetic.Select2.FittestRandom;

    genetic.generation = (pop, gen, stats) => {
        return (pop[0].fitness > 10);
    }

    genetic.notification = (pop, gen, stats, isFinished) => {
        console.log(gen, pop[0].fitness, stats);
        
        let w = ResultCtx.canvas.width;
        let h = ResultCtx.canvas.height;
        var canvas = new OffscreenCanvas(w, h);
        drawControlGrid(canvas.getContext("2d"), pop[0].entity, 50);

        ResultCtx.clearRect(0,0,w,h);
        ResultCtx.drawImage(canvas, 0, 0);

        if(isFinished) {
            console.log(pop);
        }
    }

    genetic.evolve({webWorkers: true, iterations:1000});
}

})();
